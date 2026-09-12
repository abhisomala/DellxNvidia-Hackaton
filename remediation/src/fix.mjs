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
 * violation was not present in the baseline scan.
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

function safeName(id) { return String(id).replace(/[^A-Za-z0-9._-]+/g, '_'); }

/** Core loop, reusable by bench. Returns the report object. */
export async function fixOne(o, violation, baseline, { runTag = '' } = {}) {
  const app = new AppFs(o);
  const agentAppRoot = o.agentBackend === 'nemoclaw' || o.execBackend === 'nemoclaw' ? (o.remoteAppRoot || o.appRoot) : resolve(o.appRoot);
  const outDir = join(o.outDir, safeName(violation.id) + (runTag ? `-${runTag}` : ''));
  mkdirSync(outDir, { recursive: true });
  const report = {
    violation_id: violation.id, rule_id: violation.rule_id, selector: violation.selector, status: 'failed',
    backend: describeBackend(o), attempts: [], started_at: new Date().toISOString(),
  };
  const t0 = Date.now();
  try {
    if (!baseline.violations.some((v) => key(v) === key(violation))) {
      report.status = 'not-in-baseline';
      report.note = 'the violation is not present in the baseline scan; nothing to fix';
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
      writeFileSync(join(outDir, `agent-reply-${attempt}.md`), (turn.final || '') + '\n\n---- stderr ----\n' + (turn.stderr || '').slice(-4000));
      const diff = await app.gitDiff();
      const changed = await app.changedFiles();
      const a = { attempt, agent_ok: turn.ok, agent_exit: turn.code, agent_ms: turn.ms, reply: (turn.final || '').slice(0, 800), files_changed: changed, diff_bytes: diff.length };
      report.attempts.push(a);
      if (!turn.ok) log(`agent turn failed (exit ${turn.code}): ${turn.stderr.slice(-300).replace(/\n/g, ' ')}`);
      if (!diff.trim()) {
        log('no files changed by the agent');
        a.verify = { ok: false, reason: 'no-change' };
        previous = { diff: '', verify: {} };
        continue;
      }
      const vr = await verify(o, app, baseline, violation, { log, diff, changedFiles: changed });
      a.verify = { ok: vr.ok, guard_ok: vr.guard?.ok, guard_reasons: vr.guard?.ok ? undefined : vr.guard?.reasons, build_ok: vr.build?.ok, target_gone: vr.scan?.targetGone, new_violations: vr.scan?.newViolations, functional_passed: vr.functional?.passed, functional: vr.functional?.passed ? undefined : vr.functional?.output, judge_ok: vr.judge?.skipped ? undefined : vr.judge?.ok, judge_reasons: vr.judge && !vr.judge.ok ? vr.judge.reasons : undefined, judge_ms: vr.judge?.ms };
      log(`verify: guard=${vr.guard?.ok} build=${vr.build?.ok} target_gone=${vr.scan?.targetGone} new=${vr.scan?.newViolations?.length ?? '-'} functional=${vr.functional?.passed} judge=${vr.judge ? (vr.judge.skipped ? 'skipped' : vr.judge.ok) : '-'}`);
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
    if (!o.keepFailed) { try { await app.restore(); } catch {} }
  }
  return finish(report, outDir, t0);
}

/** The teammate's `patches` document shape (db/mongo_store.py insert_patch) plus what insert_scan needs. */
function buildMongoPatch(o, violation, baseline, loc, report) {
  const diff = report.patch || '';
  const original = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).map((l) => l.slice(1)).join('\n');
  const patched = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n');
  return {
    scan_id: baseline?.scan?.mongo_scan_id || null,
    target_app: baseline?.scan?.target_app || null,
    violation_rule_id: violation.rule_id,
    source_file: loc?.file || violation.source?.file || violation.mongo?.source_file || '',
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
    else { log(`FAILED ${violation.id} after ${report.attempts.length} attempt(s)`); process.exitCode = 1; }
  } finally {
    server.stop();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { log(`fatal: ${e.message}`); process.exit(1); });
}
