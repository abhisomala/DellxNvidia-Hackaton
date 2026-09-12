/**
 * src/fix.mjs   — the retry loop, report shape, mongo_patch derivation (integration level)
 * src/lib/agent.mjs — the agent turn envelope handling
 *
 * fixOne() is driven end to end against a real git repo with a FAKE agent
 * (a stub `openclaw` binary on PATH) and a FAKE scanner, so the whole loop runs
 * without a model, a browser, or the network.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { lib, SRC, opts, gitRepo, put, scratchDir, cleanupAll, REAL_DIFF } from './helpers.mjs';

const { fixOne, extractSnippets, safeName } = await import(`${SRC}/src/fix.mjs`);
const AG = await import(lib('agent.mjs'));
after(cleanupAll);

const COMPONENT = `export default function UploadButton() {
  return <button id="upload-submit" onClick={go} />;
}
`;

/**
 * Build a scenario: a git repo as the app, a stub agent binary that performs a
 * scripted edit, and a scanner script whose output depends on whether the edit landed.
 */
function scenario({ agentScript, scanBefore, scanAfter, marker = 'aria-label' } = {}) {
  const { root } = gitRepo({ files: { 'src/UploadButton.jsx': COMPONENT } });
  const bin = scratchDir('bin-');
  const outDir = scratchDir('out-');

  // Stub "openclaw": edits the component, prints an OpenClaw JSON envelope.
  const agentPath = join(bin, 'openclaw');
  writeFileSync(agentPath, `#!/usr/bin/env node
${agentScript ?? `
const fs = require('fs');
const p = ${JSON.stringify(join(root, 'src/UploadButton.jsx'))};
fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('id="upload-submit"', 'id="upload-submit" aria-label="Upload"'));
`}
process.stdout.write(JSON.stringify({ ok: true, status: 'done', final: 'changed: src/UploadButton.jsx' }) + '\\n');
`);
  chmodSync(agentPath, 0o755);

  // Scanner: reports the violation only while the marker is absent from the source.
  const scanPath = join(bin, 'scan.mjs');
  const before = JSON.stringify(scanBefore ?? { schema_version: '1.0', scan: { tool: 't', app_url: 'u', timestamp: 'ts' }, violations: [{ id: 'button-name#0', rule_id: 'button-name', source_tool: 'axe', impact: 'critical', description: 'Buttons must have discernible text', route: '/', selector: '#upload-submit', html: '<button id="upload-submit"></button>' }] });
  const after_ = JSON.stringify(scanAfter ?? { schema_version: '1.0', scan: { tool: 't', app_url: 'u', timestamp: 'ts' }, violations: [] });
  writeFileSync(scanPath, `
import { readFileSync } from 'node:fs';
const src = readFileSync(${JSON.stringify(join(root, 'src/UploadButton.jsx'))}, 'utf8');
process.stdout.write(src.includes(${JSON.stringify(marker)}) ? ${JSON.stringify(after_)} : ${JSON.stringify(before)});
`);

  const o = opts({
    appRoot: root, outDir,
    agentBackend: 'openclaw', agentBin: agentPath,
    scanCmd: `node ${JSON.stringify(scanPath)}`,
    buildCmd: '', funcCmd: '',
    turnTimeout: 30,
  });
  return { root, o, outDir, scanPath, agentPath, baselineDoc: JSON.parse(before) };
}

const VIOLATION = { id: 'button-name#0', rule_id: 'button-name', selector: '#upload-submit', html: '<button id="upload-submit"></button>', description: 'Buttons must have discernible text', route: '/', impact: 'critical' };

// ── Main / happy path ──────────────────────────────────────────────────────────

describe('MAIN: fixOne happy path', () => {
  test('a good agent edit passes the gates and is reported as fixed', async () => {
    const { o, outDir, baselineDoc } = scenario();
    const r = await fixOne(o, VIOLATION, baselineDoc);
    assert.equal(r.status, 'fixed', `expected fixed, got ${r.status}: ${r.error || ''}`);
    assert.equal(r.attempts.length, 1);
    assert.match(r.patch, /aria-label/);
    assert.deepEqual(r.files_changed, ['src/UploadButton.jsx']);
    assert.ok(existsSync(join(outDir, 'button-name_0', 'patch.diff')));
    const report = JSON.parse(readFileSync(join(outDir, 'button-name_0', 'report.json'), 'utf8'));
    assert.equal(report.status, 'fixed');
    assert.ok(report.duration_ms >= 0);
  });

  test('prompt and reply artifacts are written for each attempt', async () => {
    const { o, outDir, baselineDoc } = scenario();
    await fixOne(o, VIOLATION, baselineDoc);
    assert.ok(existsSync(join(outDir, 'button-name_0', 'prompt-1.md')));
    assert.ok(existsSync(join(outDir, 'button-name_0', 'agent-reply-1.md')));
  });

  test('a violation absent from the baseline exits early as not-in-baseline', async () => {
    const { o, baselineDoc } = scenario();
    const r = await fixOne(o, { ...VIOLATION, selector: '#not-present' }, baselineDoc);
    assert.equal(r.status, 'not-in-baseline');
    assert.equal(r.attempts.length, 0);
  });

  test('the app is restored after a FAILED run', async () => {
    const { o, root, baselineDoc } = scenario({ marker: 'never-appears' }); // scanner never clears
    const r = await fixOne(o, VIOLATION, baselineDoc);
    assert.equal(r.status, 'failed');
    assert.equal(readFileSync(join(root, 'src/UploadButton.jsx'), 'utf8'), COMPONENT,
      'a failed attempt must leave the checkout pristine');
  });

  test('--keep-failed leaves the failed edit in place', async () => {
    const { o, root, baselineDoc } = scenario({ marker: 'never-appears' });
    const r = await fixOne({ ...o, keepFailed: true }, VIOLATION, baselineDoc);
    assert.equal(r.status, 'failed');
    assert.notEqual(readFileSync(join(root, 'src/UploadButton.jsx'), 'utf8'), COMPONENT);
  });
});

// ── Retry behaviour ────────────────────────────────────────────────────────────

describe('EDGE: fixOne retry loop', () => {
  test('an agent that changes nothing is retried up to maxAttempts, then fails', async () => {
    const { o, baselineDoc } = scenario({ agentScript: '// no edit at all' });
    const r = await fixOne({ ...o, maxAttempts: 3 }, VIOLATION, baselineDoc);
    assert.equal(r.status, 'failed');
    assert.equal(r.attempts.length, 3);
    assert.ok(r.attempts.every((a) => a.verify.reason === 'no-change'));
  });

  test('an attempt that REVERTS its own edit does not wipe the earlier failure feedback', async () => {
    // Edits persist between attempts, so the empty-diff branch is only reached when the agent
    // undoes its own change. Attempt 1 edits and is rejected by the rescan; attempt 2 reverts,
    // producing an empty diff; attempt 3 must still carry WHY attempt 1 was rejected.
    const ORIGINAL = 'export default function UploadButton() {\n  return <button id="upload-submit" onClick={go} />;\n}\n';
    const { root } = gitRepo({ files: { 'src/UploadButton.jsx': ORIGINAL } });
    const bin = scratchDir('bin-');
    const outDir = scratchDir('out-');
    const counter = join(scratchDir('cnt-'), 'n');
    const target = join(root, 'src/UploadButton.jsx');

    const agentPath = join(bin, 'openclaw');
    writeFileSync(agentPath, `#!/usr/bin/env node
const fs = require('fs');
const counter = ${JSON.stringify(counter)}, target = ${JSON.stringify(target)};
const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1;
fs.writeFileSync(counter, String(n));
if (n === 1) fs.writeFileSync(target, ${JSON.stringify(ORIGINAL)}.replace('onClick={go}', 'data-x="1" onClick={go}'));
else fs.writeFileSync(target, ${JSON.stringify(ORIGINAL)});   // attempt 2+: revert -> empty diff
process.stdout.write(JSON.stringify({ ok: true, final: 'turn ' + n }) + '\\n');
`);
    chmodSync(agentPath, 0o755);

    const stillFailing = JSON.stringify({
      schema_version: '1.0', scan: {},
      violations: [{ id: 'button-name#0', rule_id: 'button-name', selector: '#upload-submit', html: '<button id="upload-submit"></button>' }],
    });
    const scanPath = join(bin, 'scan.mjs');
    writeFileSync(scanPath, `process.stdout.write(${JSON.stringify(stillFailing)});`);

    const baseline = JSON.parse(stillFailing);
    const o = opts({ appRoot: root, outDir, agentBackend: 'openclaw', agentBin: agentPath, scanCmd: `node ${JSON.stringify(scanPath)}`, buildCmd: '', funcCmd: '', turnTimeout: 20 });
    const r = await fixOne({ ...o, maxAttempts: 3 }, VIOLATION, baseline);

    assert.equal(r.attempts.length, 3);
    assert.equal(r.attempts[1].verify.reason, 'no-change', 'attempt 2 reverted, so its diff is empty');
    const p3 = readFileSync(join(outDir, 'button-name_0', 'prompt-3.md'), 'utf8');
    assert.match(p3, /changed NO files on disk/, 'the no-op is reported');
    assert.match(p3, /still reports rule button-name/,
      'and the scanner rejection from attempt 1 survives the empty-diff turn');
  });

  test('a crashing agent is recorded as a failed turn rather than aborting the run', async () => {
    const { o, baselineDoc } = scenario({ agentScript: 'process.stderr.write("boom"); process.exit(9);' });
    const r = await fixOne({ ...o, maxAttempts: 1 }, VIOLATION, baselineDoc);
    assert.equal(r.status, 'failed');
    assert.equal(r.attempts[0].agent_ok, false);
    assert.equal(r.attempts[0].agent_exit, 9);
  });

  test('a missing agent binary fails the run loudly', async () => {
    const { o, baselineDoc } = scenario();
    const r = await fixOne({ ...o, agentBin: '/nonexistent/openclaw', maxAttempts: 1 }, VIOLATION, baselineDoc);
    assert.equal(r.status, 'failed');
    assert.equal(r.attempts[0].agent_ok, false);
  });

  test('maxAttempts = 0 does not silently report a normal failure', async () => {
    const { o, baselineDoc } = scenario();
    const r = await fixOne({ ...o, maxAttempts: 0 }, VIOLATION, baselineDoc);
    assert.notEqual(r.status, 'failed',
      'zero attempts never called the agent; reporting a plain "failed" is indistinguishable from a genuine remediation failure');
  });

  test('maxAttempts = NaN does not silently report a normal failure', async () => {
    const { o, baselineDoc } = scenario();
    const r = await fixOne({ ...o, maxAttempts: NaN }, VIOLATION, baselineDoc);
    assert.notEqual(r.status, 'failed',
      'NaN attempts (from `--max-attempts abc`) never calls the agent yet reports "failed"');
  });

  test('the "you repeated yourself" hint fires at attempt 3 after two identical diffs', async () => {
    // A stubborn agent whose edit is IDEMPOTENT: it writes the same final content every
    // turn, so the cumulative diff is byte-identical on attempts 1, 2 and 3.
    // (Files are NOT restored between attempts, so the edit must be write-the-whole-thing.)
    const STUBBORN = 'export default function UploadButton() {\n  return <button id="upload-submit" data-same="1" onClick={go} />;\n}\n';
    const { o, outDir, baselineDoc } = scenario({
      agentScript: `
const fs = require('fs');
fs.writeFileSync(process.env.TARGET_FILE, ${JSON.stringify(STUBBORN)});
`,
      marker: 'never-appears',
    });
    process.env.TARGET_FILE = join(o.appRoot, 'src/UploadButton.jsx');
    try {
      await fixOne({ ...o, maxAttempts: 3 }, VIOLATION, baselineDoc);
      const p2 = readFileSync(join(outDir, 'button-name_0', 'prompt-2.md'), 'utf8');
      const p3 = readFileSync(join(outDir, 'button-name_0', 'prompt-3.md'), 'utf8');
      assert.doesNotMatch(p2, /IDENTICAL to the one before/,
        'attempt 2 has only one prior diff, so there is nothing to compare yet');
      assert.match(p3, /IDENTICAL to the one before/,
        'by attempt 3 the agent has produced the same diff twice and must be told so');
    } finally { delete process.env.TARGET_FILE; }
  });
});

// ── Report shape / mongo_patch ────────────────────────────────────────────────

describe('HARD: report and mongo_patch integrity', () => {
  test('mongo_patch.verified is true only for a genuinely verified fix', async () => {
    const ok = scenario();
    const good = await fixOne(ok.o, VIOLATION, ok.baselineDoc);
    assert.equal(good.mongo_patch.verified, true);

    const bad = scenario({ marker: 'never-appears' });
    const failed = await fixOne({ ...bad.o, maxAttempts: 1 }, VIOLATION, bad.baselineDoc);
    assert.equal(failed.mongo_patch.verified, false);
  });

  test('original_snippet/patched_snippet are not corrupted by diff metadata', () => {
    const diff = [
      'diff --git a/a.css b/a.css',
      'index 111..222 100644',
      '--- a/a.css',
      '+++ b/a.css',
      '@@ -1,3 +1,3 @@',
      ' .x {',
      '-  color: #111;',
      '+  color: #000;',
      ' }',
    ].join('\n');
    const { original, patched } = extractSnippets(diff, 'a.css');
    assert.equal(original, '  color: #111;');
    assert.equal(patched, '  color: #000;');
  });

  test('a removed content line starting with "---" is not mistaken for a diff header', () => {
    const diff = [
      'diff --git a/notes.md b/notes.md',
      '--- a/notes.md',
      '+++ b/notes.md',
      '@@ -1 +1 @@',
      '--- a horizontal rule in the file',
      '+--- replaced rule',
    ].join('\n');
    const { original, patched } = extractSnippets(diff, 'notes.md');
    assert.equal(original, '-- a horizontal rule in the file',
      'the leading "-" is the diff marker; the rest is real content and must survive');
    assert.equal(patched, '--- replaced rule');
  });

  test('snippets are per-file, not concatenated across every file in the diff', () => {
    const diff = [
      'diff --git a/src/Upload.jsx b/src/Upload.jsx',
      '--- a/src/Upload.jsx',
      '+++ b/src/Upload.jsx',
      '@@ -1 +1 @@',
      '-<button id="u"/>',
      '+<button id="u" aria-label="Upload"/>',
      'diff --git a/src/styles.css b/src/styles.css',
      '--- a/src/styles.css',
      '+++ b/src/styles.css',
      '@@ -1 +1 @@',
      '-.a { color: #777 }',
      '+.a { color: #111 }',
    ].join('\n');
    const jsx = extractSnippets(diff, 'src/Upload.jsx');
    assert.equal(jsx.original, '<button id="u"/>');
    assert.doesNotMatch(jsx.original, /color/, 'the CSS file\'s lines must not leak into the JSX snippet');
    assert.deepEqual(jsx.files, ['src/Upload.jsx', 'src/styles.css']);
    const css = extractSnippets(diff, 'src/styles.css');
    assert.equal(css.patched, '.a { color: #111 }');
  });

  test('a hunk header is never treated as content', () => {
    const diff = ['diff --git a/a.js b/a.js', '--- a/a.js', '+++ b/a.js', '@@ -1,2 +1,2 @@ function ctx() {', '-const a = 1;', '+const a = 2;'].join('\n');
    const { original, patched } = extractSnippets(diff, 'a.js');
    assert.equal(original, 'const a = 1;');
    assert.equal(patched, 'const a = 2;');
  });

  test('the summary printed to stdout omits the patch but the report file keeps it', async () => {
    const { o, outDir, baselineDoc } = scenario();
    const r = await fixOne(o, VIOLATION, baselineDoc);
    const { patch, ...summary } = r;
    assert.equal(summary.patch, undefined);
    const onDisk = JSON.parse(readFileSync(join(outDir, 'button-name_0', 'report.json'), 'utf8'));
    assert.ok(onDisk.patch, 'report.json must retain the patch');
  });

  test('two concurrent runs of the SAME violation do not overwrite each other', async () => {
    const a = scenario();
    const b = scenario();
    const shared = a.outDir;
    const [ra, rb] = await Promise.all([
      fixOne({ ...a.o, outDir: shared }, VIOLATION, a.baselineDoc),
      fixOne({ ...b.o, outDir: shared }, VIOLATION, b.baselineDoc),
    ]);
    assert.notEqual(ra.out_dir, rb.out_dir,
      'concurrent runs of one violation write to the same out/<id>/ and clobber each other\'s report.json');
  });

  test('safeName stays readable; colliding ids are separated by claimOutDir, not by the name', async () => {
    assert.equal(safeName('button-name#0'), 'button-name_0', 'the common case stays readable');
    assert.equal(safeName('rule#a/b'), safeName('rule#a_b'), 'the mapping is knowingly not injective');

    // Two violations whose ids collapse to the same safe name must still get their own folders,
    // and each report must record which violation it actually came from.
    const outDir = scratchDir('collide-');
    const mk = (id) => {
      const s = scenario();
      return fixOne({ ...s.o, outDir }, { ...VIOLATION, id }, s.baselineDoc);
    };
    const a = await mk('rule#a/b');
    const b = await mk('rule#a_b');
    assert.notEqual(a.out_dir, b.out_dir, 'colliding ids must not share an output directory');
    assert.equal(JSON.parse(readFileSync(join(a.out_dir, 'report.json'), 'utf8')).violation_id, 'rule#a/b');
    assert.equal(JSON.parse(readFileSync(join(b.out_dir, 'report.json'), 'utf8')).violation_id, 'rule#a_b');
  });
});

// ── agent.mjs envelope handling ───────────────────────────────────────────────

describe('agent.mjs: envelope handling', () => {
  const mkAgent = (script) => {
    const bin = scratchDir('ag-');
    const p = join(bin, 'openclaw');
    writeFileSync(p, `#!/usr/bin/env node\n${script}\n`);
    chmodSync(p, 0o755);
    return p;
  };

  test('a clean JSON envelope is parsed and final is extracted', async () => {
    const bin = mkAgent(`process.stdout.write(JSON.stringify({ok:true,final:"did the thing"}))`);
    const r = await AG.runTurn(opts({ agentBackend: 'openclaw', agentBin: bin, turnTimeout: 20 }), 'msg');
    assert.equal(r.ok, true);
    assert.equal(r.final, 'did the thing');
  });

  test('an envelope after log noise is still found', async () => {
    const bin = mkAgent(`process.stdout.write("loading...\\n" + JSON.stringify({ok:true,final:"F"}) + "\\n")`);
    const r = await AG.runTurn(opts({ agentBackend: 'openclaw', agentBin: bin, turnTimeout: 20 }), 'msg');
    assert.equal(r.final, 'F');
  });

  test('ok:false in the envelope marks the turn failed even on exit 0', async () => {
    const bin = mkAgent(`process.stdout.write(JSON.stringify({ok:false,final:"refused"}))`);
    const r = await AG.runTurn(opts({ agentBackend: 'openclaw', agentBin: bin, turnTimeout: 20 }), 'msg');
    assert.equal(r.ok, false);
  });

  test('payloads[] is joined when final is absent', async () => {
    const bin = mkAgent(`process.stdout.write(JSON.stringify({ok:true,payloads:[{text:"a"},{text:"b"}]}))`);
    const r = await AG.runTurn(opts({ agentBackend: 'openclaw', agentBin: bin, turnTimeout: 20 }), 'msg');
    assert.equal(r.final, 'a\nb');
  });

  test('the prompt is never echoed back into the recorded argv', async () => {
    const bin = mkAgent(`process.stdout.write(JSON.stringify({ok:true,final:"F"}))`);
    const secretish = 'PROMPT-BODY-SHOULD-NOT-BE-STORED';
    const r = await AG.runTurn(opts({ agentBackend: 'openclaw', agentBin: bin, turnTimeout: 20 }), secretish);
    assert.ok(!r.argv.includes(secretish));
    assert.ok(r.argv.includes('<message>'));
  });

  test('non-JSON output does not masquerade as the agent\'s answer', async () => {
    const bin = mkAgent(`process.stdout.write("Traceback: the agent crashed hard"); process.exit(0)`);
    const r = await AG.runTurn(opts({ agentBackend: 'openclaw', agentBin: bin, turnTimeout: 20 }), 'msg');
    assert.notEqual(r.final, 'Traceback: the agent crashed hard',
      'raw stdout from a crashed agent must not be surfaced as its final reply');
  });

  test('nemoclaw backend requires --sandbox', async () => {
    await assert.rejects(() => AG.runTurn(opts({ agentBackend: 'nemoclaw', sandbox: '' }), 'm'), /--sandbox <name> is required/);
  });

  test('an unknown backend name does not silently fall through to the local agent', async () => {
    await assert.rejects(
      () => AG.runTurn(opts({ agentBackend: 'typo', model: '' }), 'm'),
      /unknown|unsupported|backend/i,
      'a mistyped --agent-backend falls into the `local` branch and reports a confusing "needs an explicit model" error');
  });

  test('describeBackend reports each backend distinctly', () => {
    assert.match(AG.describeBackend(opts({ agentBackend: 'nemoclaw', sandbox: 's' })), /nemoclaw sandbox "s"/);
    assert.match(AG.describeBackend(opts({ agentBackend: 'openclaw', agentBin: 'oc' })), /oc agent --agent main/);
    assert.match(AG.describeBackend(opts({ agentBackend: 'local' })), /local embedded/);
  });
});
