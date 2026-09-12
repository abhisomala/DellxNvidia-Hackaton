/**
 * src/lib/locate.mjs — selector/html -> source file+line (regexes built from untrusted scanner output)
 * src/lib/prompt.mjs — the agent prompt
 * src/lib/args.mjs   — CLI parsing
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { lib, fakeApp, cleanupAll } from './helpers.mjs';

const L = await import(lib('locate.mjs'));
const PR = await import(lib('prompt.mjs'));
const AR = await import(lib('args.mjs'));
after(cleanupAll);

const UPLOAD = `import React, { useState } from 'react';
export default function UploadButton() {
  const [status, setStatus] = useState('');
  return (
    <button id="upload-submit" className="icon-btn" onClick={handleUpload}>
      <svg width="20" />
    </button>
  );
}
`;
const ENROLL = `export default function EnrollForm() {
  return (
    <form id="enroll-form">
      <span className="hint">Cornell email</span>
      <input id="student-email" type="email" />
    </form>
  );
}
`;

// ── locate: main functionality ─────────────────────────────────────────────────

describe('MAIN: locate finds the right source file', () => {
  test('matches by element id from the selector', async () => {
    const app = fakeApp({ 'src/UploadButton.jsx': UPLOAD, 'src/EnrollForm.jsx': ENROLL });
    const r = await L.locate(app, { id: 'button-name#0', rule_id: 'button-name', selector: '#upload-submit', html: '<button id="upload-submit" class="icon-btn"></button>' });
    assert.equal(r.file, 'src/UploadButton.jsx');
    assert.equal(r.method, 'search');
    assert.equal(r.line, 5);
  });

  test('an explicit violation.source short-circuits the search', async () => {
    const app = fakeApp({ 'src/Given.jsx': 'whatever\n', 'src/UploadButton.jsx': UPLOAD }, { local: false });
    const r = await L.locate(app, { id: 'x#0', rule_id: 'button-name', selector: '#upload-submit', html: '', source: { file: 'src/Given.jsx', line: 42 } });
    assert.equal(r.file, 'src/Given.jsx');
    assert.equal(r.line, 42);
    assert.equal(r.method, 'provided');
  });

  test('htmlFor associations are matched (label rule)', async () => {
    const app = fakeApp({ 'src/EnrollForm.jsx': ENROLL, 'src/Other.jsx': 'const x = 1;\n' });
    const r = await L.locate(app, { id: 'label#0', rule_id: 'label', selector: '#student-email', html: '<input id="student-email" type="email">' });
    assert.equal(r.file, 'src/EnrollForm.jsx');
  });

  test('the keyboard rule boost steers toward the file with key handling', async () => {
    const dialog = `function SettingsDialog(){\n  function onKeyDown(event){ if (event.key !== 'Tab') return; }\n  return <div id="settings-dialog" role="dialog" />;\n}\n`;
    const app = fakeApp({ 'src/SettingsDialog.jsx': dialog, 'src/Plain.jsx': 'const settingsDialog = 1;\n' });
    const r = await L.locate(app, { id: 'keyboard-trap#0', rule_id: 'keyboard-trap', selector: '#settings-dialog', html: '<div id="settings-dialog" role="dialog">' });
    assert.equal(r.file, 'src/SettingsDialog.jsx');
  });

  test('candidates are ranked and exposed for the report', async () => {
    const app = fakeApp({ 'src/UploadButton.jsx': UPLOAD, 'src/EnrollForm.jsx': ENROLL });
    const r = await L.locate(app, { id: 'label#0', rule_id: 'label', selector: '#student-email', html: '<input id="student-email">' });
    assert.ok(r.candidates.length >= 1);
    assert.equal(r.candidates[0].file, 'src/EnrollForm.jsx');
    assert.ok(r.candidates[0].score > 0);
  });

  test('a whole small file is sent verbatim; a big file is windowed around the line', async () => {
    const big = Array.from({ length: 500 }, (_, i) => (i === 300 ? '<button id="target-btn" />' : `// line ${i}`)).join('\n');
    const app = fakeApp({ 'src/Big.jsx': big });
    const r = await L.locate(app, { id: 'b#0', rule_id: 'button-name', selector: '#target-btn', html: '<button id="target-btn"></button>' });
    assert.ok(r.snippetTo - r.snippetFrom <= 81, 'a large file is windowed');
    assert.ok(r.snippet.includes('target-btn'));
  });
});

describe('EDGE: locate', () => {
  test('no matching file throws a descriptive error', async () => {
    const app = fakeApp({ 'src/Unrelated.jsx': 'const x = 1;\n' });
    await assert.rejects(
      () => L.locate(app, { id: 'z#0', rule_id: 'button-name', selector: '#nothing-here', html: '<button id="nothing-here"></button>' }),
      /could not locate source/);
  });

  test('an unreadable file is skipped rather than aborting the search', async () => {
    const app = {
      local: true, root: '/fake',
      async listSourceFiles() { return ['bad.jsx', 'src/UploadButton.jsx']; },
      async readFile(f) { if (f === 'bad.jsx') throw new Error('EACCES'); return UPLOAD; },
    };
    const r = await L.locate(app, { id: 'b#0', rule_id: 'button-name', selector: '#upload-submit', html: '<button id="upload-submit"></button>' });
    assert.equal(r.file, 'src/UploadButton.jsx');
  });

  test('an empty html and a selector with no id still search by text', async () => {
    const app = fakeApp({ 'src/UploadButton.jsx': UPLOAD });
    await assert.rejects(() => L.locate(app, { id: 'x#0', rule_id: 'r', selector: 'main > section:nth-of-type(1) > button', html: '' }),
      /could not locate source/, 'with no tokens at all it must fail loudly, not pick an arbitrary file');
  });

  test('tokensFor extracts ids, classes, attrs and text', () => {
    const t = L.tokensFor({ selector: '#a', html: '<button id="b" class="x y" aria-label="Go" data-test="t">Click me now</button>' });
    assert.ok(t.ids.includes('a') && t.ids.includes('b'));
    assert.deepEqual(t.classes, ['x', 'y']);
    assert.ok(t.attrs.some((a) => a.startsWith('aria-label=')));
    assert.ok(t.text[0].includes('Click me now'));
  });
});

describe('HARD: locate against adversarial scanner/model output', () => {
  // Regexes are built from selector/html/text with escapeRx(), which escapes
  // . * + ? ^ $ { } ( ) | [ ] \  — but NOT '-' (harmless) and is not applied everywhere.
  const hostile = [
    ['regex metacharacters in an id', '<button id="a(b[c" ></button>', '#a(b[c'],
    ['a lone backslash in a class', '<button class="a\\" ></button>', '#x'],
    ['unbalanced bracket in text', '<button id="t1">a) b] c} d</button>', '#t1'],
    ['very long text node', `<button id="t2">${'word '.repeat(400)}</button>`, '#t2'],
    ['nested quotes in an attribute', `<input id="t3" placeholder='he said "hi"'>`, '#t3'],
    ['unicode and emoji in text', '<button id="t4">Envoyer ✅ 日本語</button>', '#t4'],
    ['newlines inside the html blob', '<button id="t5">\n  multi\n  line\n</button>', '#t5'],
  ];
  for (const [label, html, selector] of hostile) {
    test(`${label}: does not throw an unhandled RegExp/other error`, async () => {
      const app = fakeApp({ 'src/UploadButton.jsx': UPLOAD, 'src/EnrollForm.jsx': ENROLL });
      // Either it locates something or it throws the descriptive "could not locate" error.
      // Anything else (SyntaxError from RegExp, TypeError) is a crash in the harness.
      try {
        await L.locate(app, { id: 'h#0', rule_id: 'button-name', selector, html });
      } catch (e) {
        assert.match(e.message, /could not locate source/,
          `hostile input must not produce an unhandled ${e.constructor.name}: ${e.message}`);
      }
    });
  }

  test('a catastrophically backtracking text token does not hang localization', async () => {
    const app = fakeApp({ 'src/A.jsx': 'x'.repeat(60000) + '\n' });
    const v = { id: 'r#0', rule_id: 'r', selector: '#nope', html: `<b id="q">${'a '.repeat(30)}</b>` };
    const t0 = Date.now();
    try { await L.locate(app, v); } catch {}
    assert.ok(Date.now() - t0 < 5000, 'localization must not stall on scanner-supplied text');
  });

  test('a line number is never reported as 0 (1-indexed contract)', async () => {
    // scoreFile computes `find(...) + 1`, which yields 0 when findIndex returns -1.
    const content = 'AAA unique-token-here\n'.repeat(3);
    const app = fakeApp({ 'src/T.jsx': content });
    const v = { id: 'r#0', rule_id: 'r', selector: '#none', html: '<b>AAA unique-token-here</b>' };
    const r = await L.locate(app, v).catch(() => null);
    if (r) assert.notEqual(r.line, 0, 'line 0 does not exist; it would produce a nonsense prompt');
  });

  test('a provided source file that does not exist locally is not blindly trusted', async () => {
    const app = fakeApp({ 'src/UploadButton.jsx': UPLOAD });
    const r = await L.locate(app, { id: 'x#0', rule_id: 'button-name', selector: '#upload-submit', html: '<button id="upload-submit"></button>', source: { file: 'src/DoesNotExist.jsx' } });
    assert.equal(r.file, 'src/UploadButton.jsx', 'a bogus source hint must fall back to the search');
  });

  test('a provided REMOTE source file is validated before being used', async () => {
    // locate() skips existence checking entirely when app.local is false (`: true`).
    const app = fakeApp({ 'src/Real.jsx': UPLOAD }, { local: false });
    await assert.rejects(
      () => L.locate(app, { id: 'x#0', rule_id: 'r', selector: '#upload-submit', html: '<button id="upload-submit"></button>', source: { file: '../../etc/passwd' } }),
      'a nonexistent/escaping remote source path must be rejected, not passed to readFile and the prompt');
  });
});

// ── prompt ────────────────────────────────────────────────────────────────────

describe('MAIN: buildFixPrompt', () => {
  const v = { id: 'button-name#0', rule_id: 'button-name', selector: '#upload-submit', html: '<button id="upload-submit"></button>', description: 'Buttons must have discernible text', impact: 'critical', wcag: ['wcag2a'], help: 'no text', help_url: 'http://h', route: '/' };
  const loc = { file: 'src/UploadButton.jsx', line: 5, snippet: UPLOAD, snippetFrom: 1, snippetTo: 9, totalLines: 9, method: 'search', candidates: [], related: [] };

  test('includes rule, selector, html, file path and the rule-specific guidance', () => {
    const p = PR.buildFixPrompt({ violation: v, location: loc, agentAppRoot: '/app' });
    assert.match(p, /rule_id: button-name/);
    assert.match(p, /#upload-submit/);
    assert.match(p, /\/app\/src\/UploadButton\.jsx/);
    assert.match(p, /aria-label/, 'the button-name guidance must be inlined');
    assert.ok(p.includes(UPLOAD), 'the verbatim snippet must be present for exact-match editing');
  });

  test('an unknown rule falls back to generic guidance rather than crashing', () => {
    const p = PR.buildFixPrompt({ violation: { ...v, rule_id: 'no-such-rule' }, location: loc, agentAppRoot: '/app' });
    assert.match(p, /standard remediation/);
  });

  test('a trailing slash on the app root does not produce a double slash', () => {
    const p = PR.buildFixPrompt({ violation: v, location: loc, agentAppRoot: '/app/' });
    assert.doesNotMatch(p, /\/app\/\/src/);
  });

  test('GUIDANCE covers every rule the fixture scanner can emit', () => {
    for (const rule of ['button-name', 'label', 'keyboard-trap', 'keyboard-unreachable']) {
      assert.ok(PR.GUIDANCE[rule], `missing guidance for ${rule}`);
    }
  });
});

describe('MAIN: buildRetryPrompt carries failure feedback back to the agent', () => {
  const v = { id: 'label#0', rule_id: 'label', selector: '#e', html: '<input id="e">', description: 'd', route: '/' };
  const loc = { file: 'a.jsx', line: 1, snippet: 'x', snippetFrom: 1, snippetTo: 1, totalLines: 1, method: 'search', candidates: [], related: [] };

  test('a build failure is quoted back', () => {
    const p = PR.buildRetryPrompt({ violation: v, location: loc, agentAppRoot: '/app', attempt: 2, previous: { diff: 'D', verify: { build: { ok: false, output: 'Unexpected token' } } } });
    assert.match(p, /build FAILED/);
    assert.match(p, /Unexpected token/);
  });
  test('a still-present rule is quoted back with the scanner message', () => {
    const p = PR.buildRetryPrompt({ violation: v, location: loc, agentAppRoot: '/app', attempt: 2, previous: { diff: 'D', verify: { scan: { targetGone: false, remainingSameRule: [{ selector: '#e', html: '<input>', help: 'still no label' }] } } } });
    assert.match(p, /still reports rule label/);
    assert.match(p, /still no label/);
  });
  test('a judge rejection is quoted back', () => {
    const p = PR.buildRetryPrompt({ violation: v, location: loc, agentAppRoot: '/app', attempt: 2, previous: { diff: 'D', verify: { judge: { ok: false, reasons: ['dead close button'] } } } });
    assert.match(p, /code review REJECTED/);
    assert.match(p, /dead close button/);
  });
  test('a no-op turn produces the "you changed nothing" instruction', () => {
    const p = PR.buildRetryPrompt({ violation: v, location: loc, agentAppRoot: '/app', attempt: 2, previous: { diff: '', verify: {} } });
    assert.match(p, /changed NO files on disk/);
  });
  test('a repeated identical edit is called out', () => {
    const p = PR.buildRetryPrompt({ violation: v, location: loc, agentAppRoot: '/app', attempt: 3, previous: { diff: 'D', verify: {}, unchanged: true } });
    assert.match(p, /IDENTICAL to the one before/);
  });

  test('a no-op turn still renders the carried-over failure reason alongside "you changed nothing"', () => {
    // fix.mjs carries the last real verify forward across a no-change turn, so attempt 3 still
    // knows WHY attempt 1 was rejected — not merely that attempt 2 did nothing.
    const carried = { build: { ok: false, output: 'Unexpected token <' } };
    const p = PR.buildRetryPrompt({ violation: v, location: loc, agentAppRoot: '/app', attempt: 3, previous: { diff: '', verify: carried, noChange: true } });
    assert.match(p, /changed NO files on disk/, 'the no-op is still called out');
    assert.match(p, /build FAILED/, 'and the original rejection reason survives');
    assert.match(p, /Unexpected token </);
  });
});

// ── args ──────────────────────────────────────────────────────────────────────

describe('MAIN: parseCommon', () => {
  test('parses the documented flags', () => {
    const o = AR.parseCommon(['--app-root', '/a', '--url', 'http://u/', '--max-attempts', '5', '--id', 'label#0', '-v']);
    assert.equal(o.appRoot, '/a');
    assert.equal(o.url, 'http://u/');
    assert.equal(o.maxAttempts, 5);
    assert.equal(o.id, 'label#0');
    assert.equal(o.verbose, true);
  });
  test('--no-judge disables a configured reviewer', () => {
    assert.equal(AR.parseCommon(['--judge-url', 'http://j/', '--no-judge']).judgeUrl, '');
  });
  test('--ids splits and trims', () => {
    assert.deepEqual(AR.parseCommon(['--ids', 'a, b ,c,']).ids, ['a', 'b', 'c']);
  });
  test('defaults point at the bundled fixtures', () => {
    const o = AR.parseCommon([]);
    assert.match(o.appRoot, /fixtures\/demo-app$/);
    assert.match(o.scanCmd, /scanner\/scan\.mjs/);
  });
});

describe('EDGE/HARD: parseCommon input validation', () => {
  test('a non-numeric --max-attempts throws rather than becoming NaN', () => {
    assert.throws(() => AR.parseCommon(['--max-attempts', 'three']), /expects a number/,
      'NaN maxAttempts would make the retry loop run zero times and report a silent failure');
  });
  test('a flag given as the LAST argument with no value throws', () => {
    assert.throws(() => AR.parseCommon(['--url']), /--url needs a value/);
  });
  test('--max-attempts 0 is rejected (the loop would never run)', () => {
    assert.throws(() => AR.parseCommon(['--max-attempts', '0']), /must be >= 1/);
  });
  test('a negative --max-added-lines is rejected', () => {
    assert.throws(() => AR.parseCommon(['--max-added-lines', '-5']), /must be >= 0/);
  });
  test('a non-numeric --max-files throws instead of disabling the guard', () => {
    assert.throws(() => AR.parseCommon(['--max-files', 'all']), /expects a number/);
  });
  test('a fractional --max-attempts is rejected', () => {
    assert.throws(() => AR.parseCommon(['--max-attempts', '2.5']), /whole number/);
  });
  test('--ids with no value throws a readable error, not a TypeError', () => {
    assert.throws(() => AR.parseCommon(['--ids']), /--ids needs a value/);
  });
  test('--runs with a bad value throws (bench parses at module top level)', () => {
    assert.throws(() => AR.parseCommon(['--runs', 'many']), /expects a number/);
  });
  test('an unknown flag is surfaced, not silently collected', () => {
    const o = AR.parseCommon(['--not-a-real-flag', 'x']);
    assert.equal(o._.includes('--not-a-real-flag'), true);
    // Documents that typos land in `_` rather than erroring.
  });
  test('an unknown agent backend is rejected before a run starts', () => {
    assert.throws(() => AR.parseCommon(['--agent-backend', 'typo-backend']), /must be one of/,
      'an unrecognised backend would silently fall through to the "local" branch in agent.mjs');
  });
  test('an unknown exec backend is rejected', () => {
    assert.throws(() => AR.parseCommon(['--exec-backend', 'sandbox']), /must be one of/);
  });
  test('valid backends still parse', () => {
    assert.equal(AR.parseCommon(['--agent-backend', 'nemoclaw']).agentBackend, 'nemoclaw');
    assert.equal(AR.parseCommon(['--exec-backend', 'nemoclaw']).execBackend, 'nemoclaw');
  });
});
