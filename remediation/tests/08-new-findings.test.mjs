/**
 * Coverage for defects surfaced by the independent hunt pass that the earlier
 * files did not already exercise. Each test states the concrete failure it guards.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { lib, SRC, opts, gitRepo, put, fakeApp, scratchDir, cleanupAll } from './helpers.mjs';

const V = await import(lib('verify.mjs'));
const AR = await import(lib('args.mjs'));
const L = await import(lib('locate.mjs'));
const PR = await import(lib('prompt.mjs'));
const A = await import(lib('app.mjs'));
const { fixOne } = await import(`${SRC}/src/fix.mjs`);
after(cleanupAll);

// ── NaN silently disables the safety guard ────────────────────────────────────

describe('NaN limits silently disable the diff-size guard', () => {
  test('--max-files with a non-numeric value must not switch the file-count check off', () => {
    const o = AR.parseCommon(['--max-files', 'all']);
    // Keep the diff small so ONLY the file-count check can reject it.
    const nineFiles = Array.from({ length: 9 }, (_, i) => `f${i}.jsx`);
    const g = V.guardDiff(o, '+x\n', nineFiles);
    assert.equal(g.ok, false,
      'Number("all") is NaN and `9 > NaN` is false, so a 9-file change sails past the file-count guard');
    assert.ok(g.reasons.some((r) => /touches 9 files/.test(r)), 'the rejection must name the file count');
  });

  test('--max-added-lines with a non-numeric value must not switch the size check off', () => {
    const o = AR.parseCommon(['--max-added-lines', '80x']);
    const g = V.guardDiff(o, '+x\n'.repeat(5000), ['a.jsx']);
    assert.equal(g.ok, false, 'a 5000-line addition must still be rejected');
  });
});

// ── locate: line=null inlines the whole file, unbounded ───────────────────────

describe('prompt size is unbounded when locate() cannot pin a line', () => {
  test('an attribute-only violation does not inline an arbitrarily large file', async () => {
    // The attrs loop raises `score` but never sets `line`; line 93 only windows `if (... && line)`.
    const big = Array.from({ length: 4000 }, (_, i) => `  // filler line ${i}`).join('\n')
      + '\n  <input type="text" name="q" />\n';
    const app = fakeApp({ 'src/Big.jsx': big });
    const v = { id: 'label#0', rule_id: 'label', selector: 'form > input', html: '<input type="text" name="q">' };
    const loc = await L.locate(app, v);
    assert.equal(loc.line !== null, true,
      'an attr-only match yields line=null, so maxWholeFile is bypassed and the entire file is inlined');
  });

  test('a huge related file is not embedded whole just because it has few lines', async () => {
    // locate() admits a `related` file on `ls.length <= 200` — a one-line minified bundle qualifies.
    const minified = '#target{color:red}' + 'a'.repeat(300000);
    const app = fakeApp({
      'src/Main.jsx': '<div id="target" className="target" />\n',
      'src/bundle.css': minified,
    });
    const v = { id: 'c#0', rule_id: 'color-contrast', selector: '#target', html: '<div id="target" class="target"></div>' };
    const loc = await L.locate(app, v);
    const prompt = PR.buildFixPrompt({ violation: v, location: loc, agentAppRoot: '/app' });
    assert.ok(prompt.length < 200000,
      `prompt grew to ${prompt.length} bytes; related files are capped by line count, not size`);
  });

  test('violation.html is truncated before going into the prompt', () => {
    const v = { id: 'b#0', rule_id: 'button-name', selector: '#b', html: '<button>' + 'x'.repeat(500000) + '</button>', description: 'd', route: '/' };
    const loc = { file: 'a.jsx', line: 1, snippet: 'x', snippetFrom: 1, snippetTo: 1, totalLines: 1, method: 'search', candidates: [], related: [] };
    const p = PR.buildFixPrompt({ violation: v, location: loc, agentAppRoot: '/app' });
    assert.ok(p.length < 100000,
      `scanner-supplied html is interpolated raw; prompt reached ${p.length} bytes`);
  });
});

// ── the catch block never demotes a 'fixed' status ────────────────────────────

describe('a failure AFTER success must not still report fixed', () => {
  test('a restore() failure after a verified fix does not leave status=fixed', async () => {
    const COMPONENT = 'export default function C(){ return <button id="b" onClick={go} />; }\n';
    const { root } = gitRepo({ files: { 'src/C.jsx': COMPONENT } });
    const bin = scratchDir('bin-');
    const outDir = scratchDir('out-');
    const agentPath = join(bin, 'openclaw');
    writeFileSync(agentPath, `#!/usr/bin/env node
const fs = require('fs');
const p = ${JSON.stringify(join(root, 'src/C.jsx'))};
fs.writeFileSync(p, fs.readFileSync(p,'utf8').replace('id="b"', 'id="b" aria-label="Go"'));
process.stdout.write(JSON.stringify({ok:true,final:"done"})+"\\n");
`);
    chmodSync(agentPath, 0o755);
    const scanPath = join(bin, 'scan.mjs');
    writeFileSync(scanPath, `
import { readFileSync } from 'node:fs';
const src = readFileSync(${JSON.stringify(join(root, 'src/C.jsx'))}, 'utf8');
process.stdout.write(src.includes('aria-label')
  ? JSON.stringify({schema_version:'1.0',scan:{},violations:[]})
  : JSON.stringify({schema_version:'1.0',scan:{},violations:[{id:'button-name#0',rule_id:'button-name',selector:'#b'}]}));
`);
    const baseline = { schema_version: '1.0', scan: {}, violations: [{ id: 'button-name#0', rule_id: 'button-name', selector: '#b' }] };
    const o = opts({
      appRoot: root, outDir, agentBackend: 'openclaw', agentBin: agentPath,
      scanCmd: `node ${JSON.stringify(scanPath)}`, buildCmd: '', funcCmd: '', turnTimeout: 20,
      restore: true,
    });
    // Make restore() fail: replace the AppFs prototype method for this run only.
    const orig = A.AppFs.prototype.restore;
    A.AppFs.prototype.restore = async function () { throw new Error('git checkout failed: permission denied'); };
    let r;
    try {
      r = await fixOne(o, { id: 'button-name#0', rule_id: 'button-name', selector: '#b', html: '<button id="b"></button>', description: 'd', route: '/' }, baseline);
    } finally { A.AppFs.prototype.restore = orig; }
    assert.notEqual(r.status, 'fixed',
      'the post-success restore threw and was recorded in report.error, but status stayed "fixed" so main() exits 0 and logs FIXED');
  });
});

// ── filenames git C-quotes are dropped from the diff ──────────────────────────

describe('agent-created files with unusual names must not vanish from the diff', () => {
  test('a file with a non-ASCII name still appears in gitDiff (guard + judge see it)', async () => {
    const { root } = gitRepo({ files: { 'a.jsx': 'x\n' } });
    put(root, 'src/Café.jsx', 'export const sneaky = 1;\n');
    const app = new A.AppFs(opts({ appRoot: root }));
    const d = await app.gitDiff();
    assert.match(d, /sneaky/,
      'git ls-files C-quotes non-ASCII names ("src/Caf\\303\\251.jsx"); shellQuote then quotes the quotes, so the file is silently dropped from the diff and bypasses both the size guard and the reviewer');
  });

  test('a file with a space in its name still appears in gitDiff', async () => {
    const { root } = gitRepo({ files: { 'a.jsx': 'x\n' } });
    put(root, 'src/New Component.jsx', 'export const spaced = 1;\n');
    const app = new A.AppFs(opts({ appRoot: root }));
    const d = await app.gitDiff();
    assert.match(d, /spaced/, 'a space in the filename must not drop it from the diff');
  });
});

// ── bench: an empty run must not report success ───────────────────────────────

describe('bench.mjs exit code', () => {
  test('rows.every() on an empty array makes a zero-run bench exit 0', () => {
    const rows = [];
    const exitCode = rows.every((r) => r.status === 'fixed') ? 0 : 1;
    assert.notEqual(exitCode, 0,
      'a bench where every --ids entry was skipped produces no rows and still reports overall success');
  });
});

// ── skipped gates are reported as passed gates ────────────────────────────────

describe('skipped gates must be distinguishable from passed gates in the report', () => {
  test('--build-cmd "" and --func-cmd "" do not produce build_ok:true / functional_passed:true', async () => {
    const app = { build: async () => ({ code: 0, stdout: '', stderr: '', skipped: true }) };
    const doc = JSON.stringify({ schema_version: '1.0', scan: {}, violations: [] });
    const o = opts({ scanCmd: `node -e ${JSON.stringify(`process.stdout.write(${JSON.stringify(doc)})`)}`, funcCmd: '' });
    const baseline = { violations: [{ id: 'l#0', rule_id: 'label', selector: '#e' }] };
    const vr = await V.verify(o, app, baseline, { rule_id: 'label', selector: '#e' }, { diff: '+x\n', changedFiles: ['a.jsx'] });
    // This is what fix.mjs:95 writes into report.json:
    const reported = { build_ok: vr.build?.ok, functional_passed: vr.functional?.passed };
    assert.notEqual(reported.build_ok, true,
      'report.json asserts build_ok:true for a build that never ran');
    assert.notEqual(reported.functional_passed, true,
      'report.json asserts functional_passed:true for a functional check that never ran');
  });
});
