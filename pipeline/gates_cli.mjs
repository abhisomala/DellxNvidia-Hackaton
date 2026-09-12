#!/usr/bin/env node
/**
 * Thin stdin-JSON CLI over Path 2's own verification gates, so the Python pipeline reuses them.
 *
 *   node pipeline/gates_cli.mjs guard < {"diff", "changed_files", "max_added_lines"?, "max_removed_lines"?, "max_files"?}
 *     -> guardDiff() result JSON {ok, added, removed, files, reasons}
 *   node pipeline/gates_cli.mjs judge < {"violation": {rule_id, description, selector, html}, "diff",
 *                                        "judge_url", "judge_model", "judge_key"?, "reasoning_effort"?}
 *     -> judge() result JSON {ok, status, ran, skipped, reasons, raw?, ms?, error?}
 *
 * Exit 0 whenever the gate ran to a verdict (`ok` decides); exit 2 on bad input or a harness error
 * (stdout then carries {ok:false, status:"error", error}).
 *
 * FAILS CLOSED. In GuardRail the reviewer is mandatory: an empty judge_url is reported as
 * status "unavailable" with ok:false, never as Path 2's opt-out "skipped".
 */
import { guardDiff, judge } from '../remediation/src/lib/verify.mjs';

const STDIN_TIMEOUT_MS = 30000;
// judge() aborts its own request after 180 s; this watchdog only catches a harness that hangs anyway.
const WATCHDOG_MS = 240000;

class BadInput extends Error {}

function fail(message) {
  process.stderr.write(`gates_cli: ${message}\n`);
  process.stdout.write(JSON.stringify({ ok: false, status: 'error', error: message }) + '\n', () => process.exit(2));
}

function readStdin() {
  if (process.stdin.isTTY) throw new BadInput('expected a JSON request on stdin (got a terminal)');
  return new Promise((resolve, reject) => {
    let input = '';
    const timer = setTimeout(() => reject(new BadInput(`no complete JSON request on stdin within ${STDIN_TIMEOUT_MS / 1000}s`)), STDIN_TIMEOUT_MS);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { input += c; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(input); });
    process.stdin.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

const isStr = (v) => typeof v === 'string';

function requireDiff(req) {
  if (!isStr(req.diff) || !req.diff.trim()) throw new BadInput('"diff" must be a non-empty string; there is no change to check');
  return req.diff;
}

/** Optional limit: absent/null -> default; anything else must be a whole number >= min. */
function limit(req, name, fallback, min) {
  const v = req[name];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) throw new BadInput(`"${name}" must be a whole number >= ${min}, got ${JSON.stringify(v)}`);
  return v;
}

function runGuard(req) {
  const diff = requireDiff(req);
  const files = req.changed_files;
  if (!Array.isArray(files) || !files.length || !files.every((f) => isStr(f) && f)) {
    throw new BadInput('"changed_files" must be a non-empty array of file names');
  }
  const o = {
    maxAddedLines: limit(req, 'max_added_lines', 80, 0),
    maxRemovedLines: limit(req, 'max_removed_lines', 40, 0),
    maxFiles: limit(req, 'max_files', 2, 1),
  };
  return guardDiff(o, diff, files);
}

async function runJudge(req) {
  const diff = requireDiff(req);
  const v = req.violation;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new BadInput('"violation" must be an object');
  if (!isStr(v.rule_id) || !v.rule_id) throw new BadInput('"violation.rule_id" must be a non-empty string');
  for (const k of ['description', 'selector', 'html']) {
    if (v[k] !== undefined && v[k] !== null && !isStr(v[k])) throw new BadInput(`"violation.${k}" must be a string`);
  }
  for (const k of ['judge_url', 'judge_model']) {
    if (!isStr(req[k])) throw new BadInput(`"${k}" must be a string`);
  }
  for (const k of ['judge_key', 'reasoning_effort']) {
    if (req[k] !== undefined && req[k] !== null && !isStr(req[k])) throw new BadInput(`"${k}" must be a string`);
  }

  const unavailable = (why) => ({
    ok: false, ran: false, skipped: false, status: 'unavailable',
    error: `judge unavailable: ${why}`,
    reasons: [`the reviewer gate is mandatory but ${why}; refusing to pass an unreviewed patch`],
  });
  if (!req.judge_url.trim()) return unavailable('no judge_url was configured');
  if (!req.judge_model.trim()) return unavailable('no judge_model was configured');

  const o = {
    judgeUrl: req.judge_url.trim(),
    judgeModel: req.judge_model.trim(),
    judgeKey: req.judge_key || '',
    judgeReasoningEffort: req.reasoning_effort || '',
  };
  const violation = {
    rule_id: v.rule_id,
    description: v.description || '',
    selector: v.selector || '',
    html: v.html || '',
  };
  const r = await judge(o, { violation, diff }, { log: (m) => process.stderr.write(`gates_cli: ${m}\n`) });
  // Belt and braces: only a reviewer that actually ran and said "passed" may approve.
  if (r.ok === true && !(r.status === 'passed' && r.ran === true)) {
    return { ...r, ok: false, reasons: [`the reviewer result was ok without a completed "passed" review (status ${JSON.stringify(r.status)}); refusing to pass`, ...(r.reasons || [])] };
  }
  return { ...r, ok: r.ok === true };
}

const GATES = { guard: runGuard, judge: runJudge };

async function main() {
  const gate = process.argv[2];
  if (!Object.hasOwn(GATES, gate)) throw new BadInput(`usage: node pipeline/gates_cli.mjs guard|judge < request.json (got ${JSON.stringify(gate ?? '')})`);
  const raw = await readStdin();
  let req;
  try { req = JSON.parse(raw); } catch (e) { throw new BadInput(`stdin is not valid JSON (${e.message})`); }
  if (!req || typeof req !== 'object' || Array.isArray(req)) throw new BadInput('the request must be a JSON object');
  const result = await GATES[gate](req);
  process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(0));
}

setTimeout(() => fail(`the gate did not finish within ${WATCHDOG_MS / 1000}s`), WATCHDOG_MS).unref();
main().catch((e) => fail(e instanceof BadInput ? `bad input: ${e.message}` : `harness error: ${e?.stack || e}`));
