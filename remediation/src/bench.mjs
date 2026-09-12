#!/usr/bin/env node
/**
 * Consistency bench: run the fixer N times per violation from a clean checkout and tabulate.
 *
 *   node remediation/src/bench.mjs [--runs 3] [--ids button-name#0,label#0,keyboard-trap#0] [fix options]
 *
 * Writes remediation/out/bench-<timestamp>.{json,md}. Exit 0 if every run of every violation was fixed.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseCommon } from './lib/args.mjs';
import { AppFs, ensureServer } from './lib/app.mjs';
import { runScan } from './lib/verify.mjs';
import { fixOne, log } from './fix.mjs';

const o = parseCommon(process.argv.slice(2), { runs: 3 });
o.restore = true;
const app = new AppFs(o);
const server = await ensureServer(o.url, o.serveCmd, { log });
try {
  await app.restore();
  const baseline = await runScan(o, { log });
  const ids = o.ids && o.ids.length ? o.ids : baseline.violations.map((v) => v.id);
  log(`bench: ${ids.length} violation(s) x ${o.runs} run(s); baseline has ${baseline.violations.length} violation(s)`);
  const rows = [];
  for (const id of ids) {
    const v = baseline.violations.find((x) => x.id === id);
    if (!v) { log(`skip ${id}: not in baseline`); continue; }
    for (let run = 1; run <= o.runs; run++) {
      await app.restore();
      const r = await fixOne(o, v, baseline, { runTag: `run${run}` });
      await app.restore();
      const last = r.attempts[r.attempts.length - 1];
      rows.push({ id, run, status: r.status, attempts: r.attempts.length, duration_s: Math.round(r.duration_ms / 1000), files: (r.files_changed || last?.files_changed || []).join(','), fail_reason: r.status === 'fixed' ? '' : (r.error ? r.error.split('\n')[0] : summarizeFail(last)) });
      log(`bench ${id} run ${run}: ${r.status} (${r.attempts.length} attempts, ${Math.round(r.duration_ms / 1000)}s)`);
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  mkdirSync(o.outDir, { recursive: true });
  const summary = {};
  for (const r of rows) { summary[r.id] ??= { fixed: 0, runs: 0, attempts: [] }; summary[r.id].runs++; if (r.status === 'fixed') summary[r.id].fixed++; summary[r.id].attempts.push(r.attempts); }
  const md = ['| violation | run | status | attempts | seconds | files | failure |', '|---|---|---|---|---|---|---|', ...rows.map((r) => `| ${r.id} | ${r.run} | ${r.status} | ${r.attempts} | ${r.duration_s} | ${r.files} | ${r.fail_reason} |`), '', '**Summary**', ...Object.entries(summary).map(([id, s]) => `- ${id}: ${s.fixed}/${s.runs} fixed, attempts ${s.attempts.join('/')}`)].join('\n');
  writeFileSync(join(o.outDir, `bench-${stamp}.json`), JSON.stringify({ backend: rows.length ? undefined : null, runs: o.runs, rows, summary }, null, 2));
  writeFileSync(join(o.outDir, `bench-${stamp}.md`), md);
  process.stdout.write(md + '\n');
  process.exitCode = rows.every((r) => r.status === 'fixed') ? 0 : 1;
} finally {
  server.stop();
}

function summarizeFail(a) {
  if (!a) return 'no attempts';
  if (!a.verify) return 'no verify';
  if (a.verify.reason) return a.verify.reason;
  if (a.verify.guard_ok === false) return 'guard: ' + (a.verify.guard_reasons || []).join(' ').slice(0, 80);
  if (a.verify.judge_ok === false) return 'judge: ' + (a.verify.judge_reasons || []).join('; ').slice(0, 120);
  if (a.verify.build_ok === false) return 'build failed';
  if (a.verify.target_gone === false) return 'rule still present';
  if (a.verify.new_violations?.length) return 'introduced ' + a.verify.new_violations.map((n) => n.rule_id).join(',');
  if (a.verify.functional_passed === false) return 'functional check failed';
  return 'unknown';
}
