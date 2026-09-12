#!/usr/bin/env node
/**
 * a11y-fix: one violation in -> verified patch out.
 *
 *   node remediation/src/fix.mjs --violation v.json            [options]
 *   node remediation/src/fix.mjs --scan scan.json --id label#0  [options]
 *   cat v.json | node remediation/src/fix.mjs                   [options]
 *
 * Loop: locate source -> prompt the OpenClaw agent to edit it -> build -> rescan (rule gone, nothing new) -> functional check
 *       -> on failure, feed the diff + failures back and retry (up to --max-attempts).
 * Output: <out-dir>/<id>/report.json + patch.diff (+ prompts and replies). Exit 0 on verified fix, 1 on failure, 3 if the
 * violation was not present in the baseline scan, 4 if the app checkout was not clean before the run, 5 if the patch
 * verified but the run failed afterwards (e.g. restore failed).
 *
 * Options (defaults in lib/args.mjs):
 *   --app-root <dir>          app checkout on this machine (default: fixtures/demo-app)
 *   --url <url>               where the app is served (default http://127.0.0.1:5174/)
 *   --serve-cmd <cmd>         start the app if --url is not reachable
 *   --scan-cmd <cmd>          Path 1 scanner; must print the violations JSON ({url} substituted)
 *   --func-cmd <cmd>          functional check; exit 0 = behavior intact ({url} substituted)
 *   --build-cmd <cmd>         compile check ({appRoot} substituted); '' to skip
 *   --agent-backend local|nemoclaw|openclaw   who runs the agent turn
 *   --exec-backend local|nemoclaw             where git/build run (nemoclaw = inside the sandbox)
 *   --sandbox <name>          NemoClaw sandbox name (nemoclaw backends)
 *   --remote-app-root <path>  app path inside the sandbox (nemoclaw backends)
 *   --agent-config <json>     OpenClaw config for the local embedded agent (default: config/openclaw.local.json)
 *   --model <provider/model>  override the agent's model for the turn
 *   --thinking <level>        off|minimal|low|medium|high
 *   --max-attempts <n>        default 3
 *   --turn-timeout <s>        per agent turn, default 420
 *   --keep-failed             leave a failed attempt's edits in place
 *   --restore                 restore the original files after a successful run (used by bench)
 *   --out-dir <dir>           default: out/ (inside this directory)
 *   --judge-url/--judge-model reviewer endpoint (OpenAI-compatible); --no-judge to skip
 *   --max-added-lines/--max-removed-lines/--max-files   diff guard limits (80/40/2)
 *   -v, --verbose             stream the agent's stdout/stderr
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { parseCommon, loadViolation } from './lib/args.mjs';
import { AppFs, ensureServer } from './lib/app.mjs';
import { locate } from './lib/locate.mjs';
import { buildFixPrompt, buildRetryPrompt } from './lib/prompt.mjs';
import { runTurn, describeBackend } from './lib/agent.mjs';
import { runScan, verify, key } from './lib/verify.mjs';

const ts = () => new Date().toISOString().slice(11, 19);
export const log = (m) => process.stderr.write(`[fix ${ts()}] ${m}\n`);

/**
 * Filesystem-safe directory name for a violation id, kept readable ('button-name#0' ->
 * 'button-name_0'). The mapping is deliberately NOT injective — 'rule#a/b' and 'rule#a_b'
 * both yield 'rule_a_b' — so two different violations can want the same folder. That is made
 * harmless by claimOutDir(), which allocates a fresh directory rather than sharing one, and by
 * report.json recording the exact `violation_id` it came from.
 */
export function safeName(id) { return String(id).replace(/[^A-Za-z0-9._-]+/g, '_'); }

/**
 * Claim an output directory atomically. Two runs of the same violation (concurrent, or a rerun)
 * must not write into one folder: the second would overwrite the first's report.json and leave
 * a confusing mix of prompt-N/agent-reply-N files from different runs.
 */
function claimOutDir(base, name) {
  mkdirSync(base, { recursive: true });
  for (let n = 1; n < 1000; n++) {
    const dir = join(base, n === 1 ? name : `${name}-${n}`);
    try { mkdirSync(dir); return dir; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error(`cannot claim an output directory under ${base} for ${name}: 999 already exist`);
}

/** Core loop, reusable by bench. Returns the report object. */
export async function fixOne(o, violation, baseline, { runTag = '' } = {}) {
  const app = new AppFs(o);
  const agentAppRoot = o.agentBackend === 'nemoclaw' || o.execBackend === 'nemoclaw' ? (o.remoteAppRoot || o.appRoot) : resolve(o.appRoot);
  const outDir = claimOutDir(o.outDir, safeName(violation.id) + (runTag ? `-${runTag}` : ''));
  const report = {
    violation_id: violation.id, rule_id: violation.rule_id, selector: violation.selector, status: 'failed',
    backend: describeBackend(o), attempts: [], started_at: new Date().toISOString(),
  };
  const t0 = Date.now();
  try {
    // Validated at parse time too; repeated here because a bad value makes `attempt <= NaN`
    // (or <= 0) skip the loop entirely, which would otherwise look like an ordinary failed run.
    if (!Number.isInteger(o.maxAttempts) || o.maxAttempts < 1) {
      report.status = 'config-error';
      report.note = `--max-attempts must be a whole number >= 1, got ${JSON.stringify(o.maxAttempts)}; the agent was never called`;
      log(`refusing to run: ${report.note}`);
      return finish(report, outDir, t0);
    }
    if (!baseline.violations.some((v) => key(v) === key(violation))) {
      report.status = 'not-in-baseline';
      report.note = 'the violation is not present in the baseline scan; nothing to fix';
      return finish(report, outDir, t0);
    }
    // The diff produced after a turn is attributed to the agent and becomes the verified patch,
    // so the checkout must be clean BEFORE the first turn. Otherwise pre-existing uncommitted work
    // is captured, gated and recorded as the model's fix.
    const dirty = await app.changedFiles();
    if (dirty.length) {
      report.status = 'dirty-worktree';
      report.dirty_files = dirty;
      report.note = `the app checkout has ${dirty.length} uncommitted change(s) before the agent ran (${dirty.slice(0, 10).join(', ')}${dirty.length > 10 ? ', ...' : ''}); commit, stash or revert them so the patch can be attributed to the agent`;
      log(`refusing to run: ${report.note}`);
      return finish(report, outDir, t0);
    }
    const loc = await locate(app, violation);
    report.location = { file: loc.file, line: loc.line, method: loc.method, candidates: loc.candidates.map((c) => `${c.file}:${c.line}(${c.score})`) };
    log(`located ${violation.id} -> ${loc.file}:${loc.line ?? '?'} (${loc.method})`);

    let previous = null;
    for (let attempt = 1; attempt <= o.maxAttempts; attempt++) {
      const prompt = attempt === 1
        ? buildFixPrompt({ violation, location: loc, agentAppRoot })
        : buildRetryPrompt({ violation, location: loc, agentAppRoot, attempt, previous });
      writeFileSync(join(outDir, `prompt-${attempt}.md`), prompt);
      log(`attempt ${attempt}/${o.maxAttempts}: sending ${prompt.length} chars to ${o.agentBackend} agent`);
      const turn = await runTurn(o, prompt, { log });
      // When no JSON envelope was parsed there is no `final`; keep the raw stdout in the
      // artifact (clearly labelled) so the turn is still diagnosable.
      writeFileSync(join(outDir, `agent-reply-${attempt}.md`),
        (turn.final || '') +
        (turn.envelope_missing ? `\n\n---- no JSON envelope parsed; raw stdout ----\n${(turn.stdout || '').slice(-8000)}` : '') +
        '\n\n---- stderr ----\n' + (turn.stderr || '').slice(-4000));
      const diff = await app.gitDiff();
      const changed = await app.changedFiles();
      const a = { attempt, agent_ok: turn.ok, agent_exit: turn.code, agent_ms: turn.ms, reply: (turn.final || '').slice(0, 800), files_changed: changed, diff_bytes: diff.length };
      report.attempts.push(a);
      if (!turn.ok) log(`agent turn failed (exit ${turn.code}): ${turn.stderr.slice(-300).replace(/\n/g, ' ')}`);
      if (!diff.trim()) {
        log('no files changed by the agent');
        a.verify = { ok: false, reason: 'no-change' };
        // Keep the last real verification feedback: otherwise a no-op turn wipes the reason the
        // previous attempt was rejected, and the next prompt only says "you changed nothing".
        previous = { diff: '', verify: previous?.verify || {}, noChange: true };
        continue;
      }
      const vr = await verify(o, app, baseline, violation, { log, diff, changedFiles: changed });
      // Every gate reports 'passed' | 'failed' | 'skipped' | 'unavailable' so a gate that never
      // ran can never be mistaken for a gate that passed.
      a.verify = { ok: vr.ok, gates: gateStatuses(vr), guard_ok: vr.guard?.ok, guard_reasons: vr.guard?.ok ? undefined : vr.guard?.reasons, build_ok: vr.build?.skipped ? 'skipped' : vr.build?.ok, target_gone: vr.scan?.targetGone, new_violations: vr.scan?.newViolations, functional_passed: vr.functional?.skipped ? 'skipped' : vr.functional?.passed, functional: vr.functional?.passed ? undefined : vr.functional?.output, judge_status: vr.judge?.status, judge_ok: vr.judge?.skipped ? undefined : vr.judge?.ok, judge_reasons: vr.judge && !vr.judge.ok ? vr.judge.reasons : undefined, judge_ms: vr.judge?.ms };
      log(`verify: ${Object.entries(gateStatuses(vr)).map(([k, v]) => `${k}=${v}`).join(' ')}`);
      if (vr.ok) {
        report.status = 'fixed';
        report.patch = diff;
        report.files_changed = changed;
        writeFileSync(join(outDir, 'patch.diff'), diff);
        report.after_scan_count = vr.scan.after;
        break;
      }
      previous = { diff, verify: vr, unchanged: !!(previous && previous.diff && previous.diff === diff) };
    }
    report.mongo_patch = buildMongoPatch(o, violation, baseline, loc, report);
    if (report.status !== 'fixed' && !o.keepFailed) { log('restoring original files'); await app.restore(); }
    if (report.status === 'fixed' && o.restore) { await app.restore(); }
  } catch (err) {
    report.error = String(err.stack || err);
    log(`error: ${err.message}`);
    // An exception AFTER the patch verified (typically the --restore at the end) left the
    // checkout in an unknown state. The patch is still genuinely verified, but the run did not
    // complete, so it must not exit 0 as a clean success.
    if (report.status === 'fixed') {
      report.status = 'error-after-fix';
      report.note = `the patch passed every gate but the run failed afterwards: ${err.message}. The app checkout may still contain the edit — check it before rerunning.`;
      log(`error after a verified fix: ${err.message}`);
    }
    if (!o.keepFailed) { try { await app.restore(); } catch {} }
  }
  return finish(report, outDir, t0);
}

/**
 * Per-gate outcome for the report. 'skipped' means the gate was deliberately disabled
 * (empty --build-cmd / --func-cmd / no --judge-url) and is NEVER conflated with 'passed'.
 */
function gateStatuses(vr) {
  const g = {};
  g.guard = vr.guard ? (vr.guard.ok ? 'passed' : 'failed') : 'not-reached';
  g.build = !vr.build ? 'not-reached' : vr.build.skipped ? 'skipped' : vr.build.ok ? 'passed' : 'failed';
  g.rescan = !vr.scan ? 'not-reached' : (vr.scan.targetGone && vr.scan.newViolations.length === 0) ? 'passed' : 'failed';
  g.functional = !vr.functional ? 'not-reached' : vr.functional.skipped ? 'skipped' : vr.functional.passed ? 'passed' : 'failed';
  g.reviewer = vr.judge?.status ?? 'not-reached';
  return g;
}

/**
 * Split a unified diff into removed/added content, per file.
 *
 * Filtering every line that starts with '-' (guarded only by '---') is wrong twice over: it
 * drops real removed lines whose CONTENT begins with '--' (a `-->` in HTML, a `---` rule in
 * Markdown), and it concatenates every hunk of every file into one blob while `source_file`
 * names only one of them. Only lines inside a hunk are content, so track hunk state instead.
 */
export function extractSnippets(diff, wantFile) {
  const files = new Map();
  let current = '', inHunk = false;
  for (const line of String(diff || '').split('\n')) {
    const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (m) { current = m[2]; inHunk = false; if (!files.has(current)) files.set(current, { original: [], patched: [] }); continue; }
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (!inHunk) continue;            // headers: index, --- a/x, +++ b/x, new file mode, ...
    if (!files.has(current)) files.set(current, { original: [], patched: [] });
    const f = files.get(current);
    if (line.startsWith('-')) f.original.push(line.slice(1));
    else if (line.startsWith('+')) f.patched.push(line.slice(1));
  }
  // Prefer the file the patch is actually attributed to; fall back to the only/first file.
  const pick = (wantFile && files.get(wantFile)) || (files.size === 1 ? [...files.values()][0] : null);
  const chosen = pick || { original: [...files.values()].flatMap((f) => f.original), patched: [...files.values()].flatMap((f) => f.patched) };
  return {
    original: chosen.original.join('\n'),
    patched: chosen.patched.join('\n'),
    files: [...files.keys()],
  };
}

/** The teammate's `patches` document shape (db/mongo_store.py insert_patch) plus what insert_scan needs. */
function buildMongoPatch(o, violation, baseline, loc, report) {
  const diff = report.patch || '';
  const sourceFile = loc?.file || violation.source?.file || violation.mongo?.source_file || '';
  const { original, patched } = extractSnippets(diff, sourceFile);
  return {
    scan_id: baseline?.scan?.mongo_scan_id || null,
    target_app: baseline?.scan?.target_app || null,
    violation_rule_id: violation.rule_id,
    source_file: sourceFile,
    original_snippet: original,
    patched_snippet: patched,
    model_used: o.agentBackend === 'nemoclaw' ? `nemoclaw:${o.sandbox}` : (o.model || 'openclaw-agent'),
    verified: report.status === 'fixed',
    violation_for_scans: { rule_id: violation.rule_id, selector: violation.selector, severity: violation.mongo?.severity || violation.impact || 'unknown', description: violation.description || '', source_file: loc?.file || violation.source?.file || '', html: violation.html || '' },
  };
}

function finish(report, outDir, t0) {
  report.duration_ms = Date.now() - t0;
  report.finished_at = new Date().toISOString();
  report.out_dir = outDir;
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}

async function main() {
  const o = parseCommon(process.argv.slice(2));
  if (o.help) { process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0] + '\n'); return; }
  const { violation, scan } = loadViolation(o);
  const server = await ensureServer(o.url, o.serveCmd, { log });
  try {
    // The supplied document only selects the target. The baseline for "nothing new appeared" must come from the
    // same scanner that runs the rescan, so always take a fresh scan here (and carry over MongoDB scan metadata).
    const baseline = await runScan(o, { log });
    if (scan?.scan?.mongo_scan_id) { baseline.scan.mongo_scan_id = scan.scan.mongo_scan_id; baseline.scan.target_app = scan.scan.target_app; }
    const report = await fixOne(o, violation, baseline);
    const { patch, ...summary } = report;
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    if (report.status === 'fixed') { log(`FIXED ${violation.id} in ${report.attempts.length} attempt(s); patch at ${join(report.out_dir, 'patch.diff')}`); process.exitCode = 0; }
    else if (report.status === 'not-in-baseline') process.exitCode = 3;
    else if (report.status === 'dirty-worktree') { log(`REFUSED ${violation.id}: ${report.note}`); process.exitCode = 4; }
    else if (report.status === 'error-after-fix') { log(`VERIFIED BUT INCOMPLETE ${violation.id}: ${report.note}`); process.exitCode = 5; }
    else if (report.status === 'config-error') { log(`CONFIG ERROR: ${report.note}`); process.exitCode = 2; }
    else { log(`FAILED ${violation.id} after ${report.attempts.length} attempt(s)`); process.exitCode = 1; }
  } finally {
    server.stop();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { log(`fatal: ${e.message}`); process.exit(1); });
}
