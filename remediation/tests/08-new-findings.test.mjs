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
const P = await import(lib('proc.mjs'));
after(cleanupAll);

// ── NaN silently disables the safety guard ────────────────────────────────────

describe('NaN limits must never silently disable the diff-size guard', () => {
  // The guard is only as good as its limits: `x > NaN` is always false, so a malformed
  // limit silently switches the check off. These are now rejected at parse time.
  test('--max-files with a non-numeric value is rejected before a run starts', () => {
    assert.throws(() => AR.parseCommon(['--max-files', 'all']), /expects a number/);
  });

  test('--max-added-lines with a non-numeric value is rejected before a run starts', () => {
    assert.throws(() => AR.parseCommon(['--max-added-lines', '80x']), /expects a number/);
  });

  test('a NaN limit reaching guardDiff directly would disable the check (why parsing must reject it)', () => {
    // Defence in depth: if a NaN ever reaches guardDiff by another route, the guard must not
    // silently pass a 9-file, 5000-line rewrite.
    const nineFiles = Array.from({ length: 9 }, (_, i) => `f${i}.jsx`);
    const g = V.guardDiff({ maxAddedLines: NaN, maxRemovedLines: NaN, maxFiles: NaN }, '+x\n'.repeat(5000), nineFiles);
    assert.equal(g.ok, false, 'guardDiff must treat a non-numeric limit as a rejection, not as "no limit"');
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
  test('a bench that executed ZERO runs does not exit 0', async () => {
    // Drives the real bench.mjs: every requested id is absent from the baseline, so no run happens.
    const { createServer } = await import('node:http');
    const srv = createServer((req, res) => { res.writeHead(200); res.end('ok'); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/`;
    const { root } = gitRepo({ files: { 'src/C.jsx': 'export default function C(){ return <b/>; }\n' } });
    const bin = scratchDir('bin-');
    const scanPath = join(bin, 'scan.mjs');
    writeFileSync(scanPath, `process.stdout.write(JSON.stringify({schema_version:'1.0',scan:{},violations:[{id:'label#0',rule_id:'label',selector:'#e'}]}));`);
    try {
      const r = await P.run(['node', `${SRC}/src/bench.mjs`,
        '--app-root', root, '--url', url, '--out-dir', scratchDir('bout-'),
        '--scan-cmd', `node ${JSON.stringify(scanPath)}`,
        '--build-cmd', '', '--func-cmd', '',
        '--ids', 'does-not-exist#0', '--runs', '1',
      ], { timeoutMs: 60000 });
      assert.notEqual(r.code, 0,
        `a bench where every --ids entry was skipped produced no rows and still reported success (exit ${r.code})`);
    } finally { srv.close(); }
  });

  test('the bench archive records which backend produced the numbers', () => {
    const src = readFileSync(`${SRC}/src/bench.mjs`, 'utf8');
    assert.doesNotMatch(src, /backend: rows\.length \? undefined : null/,
      'the backend field was vacuous in both branches, so archives could not be attributed');
    assert.match(src, /backend: describeBackend\(o\)/);
  });
});

// ── skipped gates are reported as passed gates ────────────────────────────────

describe('skipped gates must be distinguishable from passed gates in the report', () => {
  test('--build-cmd "" and --func-cmd "" are recorded as skipped, never as passed, in report.json', async () => {
    // The real contract is what fix.mjs writes to disk, so drive the whole loop and read it back.
    const COMPONENT = 'export default function C(){ return <button id="b" onClick={go} />; }\n';
    const { root } = gitRepo({ files: { 'src/C.jsx': COMPONENT } });
    const bin = scratchDir('bin-');
    const outDir = scratchDir('out-');
    const agentPath = join(bin, 'openclaw');
    writeFileSync(agentPath, `#!/usr/bin/env node
const fs = require('fs');
const p = ${JSON.stringify(join(root, 'src/C.jsx'))};
fs.writeFileSync(p, fs.readFileSync(p,'utf8').replace('id="b"','id="b" aria-label="Go"'));
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
    const o = opts({ appRoot: root, outDir, agentBackend: 'openclaw', agentBin: agentPath, scanCmd: `node ${JSON.stringify(scanPath)}`, buildCmd: '', funcCmd: '', turnTimeout: 20 });
    const r = await fixOne(o, { id: 'button-name#0', rule_id: 'button-name', selector: '#b', html: '<button id="b"></button>', description: 'd', route: '/' }, baseline);

    assert.equal(r.status, 'fixed', `expected a verified fix, got ${r.status}: ${r.error || ''}`);
    const v = r.attempts.at(-1).verify;
    assert.notEqual(v.build_ok, true, 'a build that never ran must not be recorded as build_ok:true');
    assert.notEqual(v.functional_passed, true, 'a functional check that never ran must not be recorded as passed');
    assert.equal(v.gates.build, 'skipped');
    assert.equal(v.gates.functional, 'skipped');
    assert.equal(v.gates.reviewer, 'skipped', 'no --judge-url means the reviewer was skipped, not passed');
    assert.equal(v.gates.guard, 'passed');
    assert.equal(v.gates.rescan, 'passed');
  });
});
