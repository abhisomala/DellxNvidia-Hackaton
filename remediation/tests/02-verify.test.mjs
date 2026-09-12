/**
 * src/lib/verify.mjs — the five gates' deterministic half:
 * guardDiff, runScan (scanner stdout parsing), compareScans, runFunctional, judge.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { lib, opts, stubServer, REAL_DIFF, cleanupAll } from './helpers.mjs';

const V = await import(lib('verify.mjs'));
after(cleanupAll);

const shCmd = (script) => `node -e ${JSON.stringify(script)}`;

// ── Main functionality ─────────────────────────────────────────────────────────

describe('MAIN: guardDiff enforces the diff-size budget', () => {
  test('a small, single-file fix passes', () => {
    const g = V.guardDiff(opts(), REAL_DIFF, ['src/App.jsx']);
    assert.equal(g.ok, true);
    assert.equal(g.added, 1);
    assert.equal(g.removed, 1);
    assert.deepEqual(g.reasons, []);
  });
  test('too many added lines is rejected with an actionable reason', () => {
    const diff = '+x\n'.repeat(81);
    const g = V.guardDiff(opts(), diff, ['a.jsx']);
    assert.equal(g.ok, false);
    assert.match(g.reasons[0], /adds 81 lines/);
  });
  test('too many removed lines is rejected', () => {
    const g = V.guardDiff(opts(), '-x\n'.repeat(41), ['a.jsx']);
    assert.equal(g.ok, false);
    assert.match(g.reasons[0], /removes 41 lines/);
  });
  test('too many files is rejected and names them', () => {
    const g = V.guardDiff(opts(), REAL_DIFF, ['a.jsx', 'b.jsx', 'c.jsx']);
    assert.equal(g.ok, false);
    assert.match(g.reasons[0], /touches 3 files \(a\.jsx, b\.jsx, c\.jsx\)/);
  });
  test('several breaches are all reported, not just the first', () => {
    const g = V.guardDiff(opts(), '+x\n'.repeat(81) + '-y\n'.repeat(41), ['a', 'b', 'c']);
    assert.equal(g.reasons.length, 3);
  });
});

describe('MAIN: compareScans decides the rescan gate', () => {
  const mk = (...pairs) => ({ violations: pairs.map(([rule_id, selector], i) => ({ id: `${rule_id}#${i}`, rule_id, selector })) });
  const target = { rule_id: 'label', selector: '#e' };

  test('target gone, nothing new -> clean pass', () => {
    const c = V.compareScans(mk(['label', '#e'], ['button-name', '#b']), mk(['button-name', '#b']), target);
    assert.equal(c.targetGone, true);
    assert.deepEqual(c.newViolations, []);
    assert.equal(c.before, 2);
    assert.equal(c.after, 1);
  });
  test('target still present -> targetGone false', () => {
    const c = V.compareScans(mk(['label', '#e']), mk(['label', '#e']), target);
    assert.equal(c.targetGone, false);
  });
  test('a regression introduced by the fix is reported as a new violation', () => {
    const c = V.compareScans(mk(['label', '#e']), mk(['color-contrast', '#e']), target);
    assert.equal(c.targetGone, true);
    assert.equal(c.newViolations.length, 1);
    assert.equal(c.newViolations[0].rule_id, 'color-contrast');
  });
  test('the same rule moving to a different selector counts as NEW, not as fixed', () => {
    // Agent deletes the element and adds a different unlabelled one.
    const c = V.compareScans(mk(['label', '#e']), mk(['label', '#e2']), target);
    assert.equal(c.targetGone, true, 'the original selector is gone...');
    assert.equal(c.newViolations.length, 1, '...but the replacement must be flagged as new');
  });
  test('collateral fixes are recorded separately', () => {
    const c = V.compareScans(mk(['label', '#e'], ['label', '#f']), mk(), target);
    assert.deepEqual(c.fixedOthers, ['label|#f']);
  });
});

// ── runScan: parsing untrusted scanner stdout ──────────────────────────────────

describe('MAIN: runScan parses a well-behaved scanner', () => {
  test('pure JSON on stdout is parsed', async () => {
    const doc = { schema_version: '1.0', scan: { tool: 't', app_url: 'u', timestamp: 'ts' }, violations: [{ id: 'label#0', rule_id: 'label', selector: '#e' }] };
    const o = opts({ scanCmd: shCmd(`process.stdout.write(${JSON.stringify(JSON.stringify(doc))})`) });
    const out = await V.runScan(o);
    assert.equal(out.violations.length, 1);
  });

  test('{url} and {appRoot} are substituted into the scan command', async () => {
    const o = opts({
      url: 'http://example.test/x', appRoot: '/my/app',
      scanCmd: shCmd('process.stdout.write(JSON.stringify({schema_version:"1.0",scan:{},violations:[{id:"a#0",rule_id:"a",selector:process.argv[1]+"|"+process.argv[2]}]}))') + ' {url} {appRoot}',
    });
    const out = await V.runScan(o);
    assert.equal(out.violations[0].selector, 'http://example.test/x|/my/app');
  });

  test('leading log noise before the JSON is tolerated', async () => {
    const o = opts({ scanCmd: shCmd('process.stdout.write("starting scan...\\n" + JSON.stringify({schema_version:"1.0",scan:{},violations:[]}))') });
    const out = await V.runScan(o);
    assert.deepEqual(out.violations, []);
  });
});

describe('EDGE/HARD: runScan against a misbehaving scanner', () => {
  test('a non-zero exit is surfaced with the scanner stderr', async () => {
    const o = opts({ scanCmd: shCmd('process.stderr.write("chromium failed to launch"); process.exit(2)') });
    await assert.rejects(() => V.runScan(o), /scanner exited 2.*chromium failed to launch/s);
  });

  test('EMPTY stdout produces an actionable error, not a bare JSON SyntaxError', async () => {
    // Math.min(...[].filter(i => i >= 0)) === Infinity; s.slice(Infinity) === ''; JSON.parse('') throws.
    const o = opts({ scanCmd: 'true' });
    await assert.rejects(() => V.runScan(o), (err) => {
      assert.doesNotMatch(err.message, /^Unexpected end of JSON input$/,
        'an empty scanner stdout must be reported as "scanner printed no JSON", not as a raw JSON parse error');
      return true;
    });
  });

  test('stdout with text but no JSON at all produces an actionable error', async () => {
    const o = opts({ scanCmd: shCmd('process.stdout.write("no browser available")') });
    await assert.rejects(() => V.runScan(o), (err) => {
      assert.match(err.message, /scanner|JSON|output/i);
      assert.doesNotMatch(err.message, /is not valid JSON$/,
        'must explain that the scanner printed no JSON document');
      return true;
    });
  });

  test('a JSON array printed before any object is parsed from the array, not from the "{"', async () => {
    // first = min(indexOf('{'), indexOf('[')) — an axe Result[] starts with '[' and its first '{' is later.
    const arr = [{ id: 'label', tags: [], nodes: [{ target: ['#e'], html: '<input>' }] }];
    const o = opts({ scanCmd: shCmd(`process.stdout.write(${JSON.stringify(JSON.stringify(arr))})`) });
    const out = await V.runScan(o);
    assert.equal(out.violations[0].rule_id, 'label');
  });

  test('log noise CONTAINING a brace before the JSON is recovered from, not fatal', async () => {
    // `Math.min(indexOf('{'), indexOf('['))` used to latch onto the brace inside the noise and
    // fail. The payload is now found by falling back to the start of a later JSON line.
    const doc = JSON.stringify({ schema_version: '1.0', scan: {}, violations: [{ id: 'label#0', rule_id: 'label', selector: '#e' }] });
    const o = opts({ scanCmd: shCmd(`process.stdout.write("debug {stale} line\\n[info] starting\\n" + ${JSON.stringify(doc)})`) });
    const out = await V.runScan(o);
    assert.equal(out.violations.length, 1);
    assert.equal(out.violations[0].selector, '#e');
  });

  test('genuinely malformed JSON is still reported with the scanner output in the message', async () => {
    const o = opts({ scanCmd: shCmd('process.stdout.write("{\\"violations\\": [ broken")') });
    await assert.rejects(() => V.runScan(o), (err) => {
      assert.match(err.message, /scanner/i, 'the error must name the scanner as the source');
      assert.match(err.message, /broken/, 'and quote what it actually printed');
      return true;
    });
  });

  test('a slow scanner is waited for (the 180s bound is hardcoded, not tied to any flag)', async () => {
    // runScan hardcodes timeoutMs: 180000 with no CLI override; a real Playwright scan of a
    // multi-route app can exceed that, and there is no --scan-timeout to raise it.
    const doc = JSON.stringify({ schema_version: '1.0', scan: {}, violations: [] });
    const o = opts({ scanCmd: shCmd(`setTimeout(() => process.stdout.write(${JSON.stringify(doc)}), 1200)`) });
    const t0 = Date.now();
    const out = await V.runScan(o);
    assert.ok(Date.now() - t0 >= 1000, 'the scanner is genuinely awaited');
    assert.deepEqual(out.violations, []);
    const src = await import('node:fs').then((fs) => fs.readFileSync(lib('verify.mjs'), 'utf8'));
    assert.match(src, /timeoutMs: 180000/, 'documents the hardcoded, non-configurable scan timeout');
  });
});

// ── judge: the gate that can silently not run ──────────────────────────────────

describe('MAIN: judge reviews a diff', () => {
  const violation = { rule_id: 'button-name', description: 'Buttons must have discernible text', selector: '#b', html: '<button id="b"></button>' };

  test('a "pass" verdict passes', async () => {
    const s = await stubServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"verdict":"pass","reasons":[]}' } }] }));
    });
    try {
      const r = await V.judge(opts({ judgeUrl: s.url, judgeModel: 'm' }), { violation, diff: REAL_DIFF });
      assert.equal(r.ok, true);
      assert.equal(r.status, 'passed', 'a genuine approval must be distinguishable from a skipped gate');
      assert.equal(r.ran, true);
      assert.ok(!r.skipped);
    } finally { await s.close(); }
  });

  test('a "fail" verdict fails, with reasons preserved', async () => {
    const s = await stubServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"verdict":"fail","reasons":["removed the onClick handler"]}' } }] }));
    });
    try {
      const r = await V.judge(opts({ judgeUrl: s.url, judgeModel: 'm' }), { violation, diff: REAL_DIFF });
      assert.equal(r.ok, false);
      assert.deepEqual(r.reasons, ['removed the onClick handler']);
    } finally { await s.close(); }
  });

  test('judge is skipped (and marked skipped) when no endpoint is configured', async () => {
    const r = await V.judge(opts({ judgeUrl: '' }), { violation, diff: REAL_DIFF });
    assert.equal(r.skipped, true);
    assert.equal(r.status, 'skipped', 'an unconfigured reviewer reports "skipped", never "passed"');
    assert.equal(r.ran, false);
    assert.equal(r.ok, true);
  });

  test('every judge outcome carries a distinct status, so "did not run" never reads as "approved"', async () => {
    const seen = {};
    seen.skipped = (await V.judge(opts({ judgeUrl: '' }), { violation, diff: REAL_DIFF })).status;
    seen.unavailable = (await V.judge(opts({ judgeUrl: 'http://127.0.0.1:1/v1', judgeModel: 'm' }), { violation, diff: REAL_DIFF })).status;
    const statusFor = async (content) => {
      const s = await stubServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content } }] })); });
      try { return (await V.judge(opts({ judgeUrl: s.url, judgeModel: 'm' }), { violation, diff: REAL_DIFF })).status; } finally { await s.close(); }
    };
    assert.equal(seen.skipped, 'skipped');
    assert.equal(seen.unavailable, 'unavailable');
    assert.notEqual(seen.skipped, seen.unavailable, 'a deliberate opt-out and an unreachable reviewer are different outcomes');
    assert.equal(await statusFor('{"verdict":"pass"}'), 'passed');
    assert.equal(await statusFor('{"verdict":"fail","reasons":["x"]}'), 'failed');
    assert.equal(await statusFor('not json at all'), 'failed');
    assert.equal(await statusFor('{"verdict":"REJECTED"}'), 'failed');
  });

  test('<think> blocks are stripped before parsing', async () => {
    const s = await stubServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '<think>hmm {"verdict":"pass"}</think>{"verdict":"fail","reasons":["nope"]}' } }] }));
    });
    try {
      const r = await V.judge(opts({ judgeUrl: s.url, judgeModel: 'm' }), { violation, diff: REAL_DIFF });
      assert.equal(r.ok, false, 'the verdict outside <think> is the real one');
    } finally { await s.close(); }
  });
});

describe('HARD: judge must FAIL CLOSED — a gate that cannot run must not report success', () => {
  const violation = { rule_id: 'button-name', description: 'd', selector: '#b', html: '<button></button>' };

  test('an unreachable judge endpoint does not count as a pass', async () => {
    const o = opts({ judgeUrl: 'http://127.0.0.1:1/v1', judgeModel: 'm' });
    const r = await V.judge(o, { violation, diff: REAL_DIFF });
    assert.notEqual(r.ok, true,
      'a configured reviewer that could not be reached must not return ok:true — that turns gate 5 into a no-op');
  });

  test('a 500 from the judge does not count as a pass', async () => {
    const s = await stubServer((req, res) => { res.writeHead(500); res.end('upstream exploded'); });
    try {
      const r = await V.judge(opts({ judgeUrl: s.url, judgeModel: 'm' }), { violation, diff: REAL_DIFF });
      assert.notEqual(r.ok, true, 'an HTTP 500 from the reviewer must not be treated as approval');
    } finally { await s.close(); }
  });

  test('an unparseable model reply does not default to pass', async () => {
    const s = await stubServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'I think this looks fine to me, honestly.' } }] }));
    });
    try {
      const r = await V.judge(opts({ judgeUrl: s.url, judgeModel: 'm' }), { violation, diff: REAL_DIFF });
      assert.notEqual(r.ok, true, 'an unparseable reviewer reply must not be silently treated as "pass"');
    } finally { await s.close(); }
  });

  test('malformed JSON inside the reply does not default to pass', async () => {
    const s = await stubServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"verdict": "fail", "reasons": [broken' } }] }));
    });
    try {
      const r = await V.judge(opts({ judgeUrl: s.url, judgeModel: 'm' }), { violation, diff: REAL_DIFF });
      assert.notEqual(r.ok, true, 'a truncated reviewer reply must not be read as approval');
    } finally { await s.close(); }
  });

  test('a garbage verdict string is not treated as approval', async () => {
    // ok is computed as `verdict !== 'fail'`, so ANY other token passes.
    const s = await stubServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"verdict":"REJECTED","reasons":["removed the button"]}' } }] }));
    });
    try {
      const r = await V.judge(opts({ judgeUrl: s.url, judgeModel: 'm' }), { violation, diff: REAL_DIFF });
      assert.notEqual(r.ok, true,
        'the verdict must be an allow-list ("pass"), not a deny-list ("anything but fail")');
    } finally { await s.close(); }
  });

  test('an API error envelope (no choices) is not treated as approval', async () => {
    const s = await stubServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'model not found', type: 'invalid_request_error' } }));
    });
    try {
      const r = await V.judge(opts({ judgeUrl: s.url, judgeModel: 'm' }), { violation, diff: REAL_DIFF });
      assert.notEqual(r.ok, true, 'an OpenAI-style error envelope must not pass the gate');
    } finally { await s.close(); }
  });

  test('the API key is not leaked into the returned/logged payload', async () => {
    const s = await stubServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"verdict":"pass"}' } }] }));
    });
    try {
      const r = await V.judge(opts({ judgeUrl: s.url, judgeModel: 'm', judgeKey: 'sk-SECRET-VALUE' }), { violation, diff: REAL_DIFF });
      assert.doesNotMatch(JSON.stringify(r), /sk-SECRET-VALUE/, 'the judge key must not appear in the report');
      assert.match(s.calls[0].headers.authorization, /^Bearer sk-SECRET-VALUE$/);
    } finally { await s.close(); }
  });
});

// ── runFunctional ──────────────────────────────────────────────────────────────

describe('runFunctional', () => {
  test('exit 0 -> passed', async () => {
    const r = await V.runFunctional(opts({ funcCmd: 'true' }));
    assert.equal(r.passed, true);
  });
  test('exit 1 -> failed, output captured for the retry prompt', async () => {
    const r = await V.runFunctional(opts({ funcCmd: shCmd('console.log("enroll form broke"); process.exit(1)') }));
    assert.equal(r.passed, false);
    assert.match(r.output, /enroll form broke/);
  });
  test('an empty funcCmd is reported as SKIPPED, distinguishable from a real pass', async () => {
    const r = await V.runFunctional(opts({ funcCmd: '' }));
    assert.equal(r.skipped, true);
    assert.equal(r.passed, true);
  });
  test('a functional command that does not exist is a failure, not a pass', async () => {
    const r = await V.runFunctional(opts({ funcCmd: 'definitely-not-a-real-binary-xyz --url {url}' }));
    assert.equal(r.passed, false, 'a missing functional-check binary must fail the gate');
  });
});

// ── verify(): gate ordering and short-circuiting ───────────────────────────────

describe('verify(): gate ordering', () => {
  const app = { build: async () => ({ code: 0, stdout: '', stderr: '' }) };
  const baseline = { violations: [{ id: 'label#0', rule_id: 'label', selector: '#e' }] };
  const target = { rule_id: 'label', selector: '#e' };

  test('a guard failure short-circuits before the build runs', async () => {
    let built = false;
    const a = { build: async () => { built = true; return { code: 0, stdout: '', stderr: '' }; } };
    const out = await V.verify(opts(), a, baseline, target, { diff: '+x\n'.repeat(999), changedFiles: ['a'] });
    assert.equal(out.ok, false);
    assert.equal(out.guard.ok, false);
    assert.equal(built, false, 'the expensive build must not run after the cheap guard fails');
  });

  test('a build failure short-circuits before the rescan runs', async () => {
    const a = { build: async () => ({ code: 1, stdout: '', stderr: 'syntax error' }) };
    const out = await V.verify(opts({ scanCmd: 'echo SHOULD_NOT_RUN; false' }), a, baseline, target, { diff: REAL_DIFF, changedFiles: ['a.jsx'] });
    assert.equal(out.ok, false);
    assert.equal(out.build.ok, false);
    assert.equal(out.scan, undefined, 'no rescan after a failed build');
  });

  test('a skipped build (--build-cmd "") is recorded as skipped, not as a passed gate', async () => {
    const a = { build: async () => ({ code: 0, stdout: '', stderr: '', skipped: true }) };
    const doc = JSON.stringify({ schema_version: '1.0', scan: {}, violations: [] });
    const out = await V.verify(opts({ scanCmd: shCmd(`process.stdout.write(${JSON.stringify(doc)})`) }), a, baseline, target, { diff: REAL_DIFF, changedFiles: ['a.jsx'] });
    assert.equal(out.build.skipped, true);
  });

  test('all objective gates green with the reviewer OFF still reports that the reviewer did not run', async () => {
    const doc = JSON.stringify({ schema_version: '1.0', scan: {}, violations: [] });
    const out = await V.verify(opts({ scanCmd: shCmd(`process.stdout.write(${JSON.stringify(doc)})`) }), app, baseline, target, { diff: REAL_DIFF, changedFiles: ['a.jsx'] });
    assert.equal(out.ok, true);
    assert.equal(out.judge.skipped, true, 'the report must make clear gate 5 never ran');
  });

  test('a reviewer rejection flips the overall verdict to false', async () => {
    const doc = JSON.stringify({ schema_version: '1.0', scan: {}, violations: [] });
    const s = await stubServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"verdict":"fail","reasons":["dead close button"]}' } }] }));
    });
    try {
      const out = await V.verify(opts({ scanCmd: shCmd(`process.stdout.write(${JSON.stringify(doc)})`), judgeUrl: s.url, judgeModel: 'm' }),
        app, baseline, target, { diff: REAL_DIFF, changedFiles: ['a.jsx'] });
      assert.equal(out.ok, false);
      assert.deepEqual(out.judge.reasons, ['dead close button']);
    } finally { await s.close(); }
  });
});
