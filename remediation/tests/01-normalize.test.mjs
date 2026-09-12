/**
 * src/lib/normalize.mjs — input shape detection and normalization.
 * This module is the harness's whole trust boundary for untrusted scanner / DB / model output.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { lib } from './helpers.mjs';

const N = await import(lib('normalize.mjs'));

// ── Main functionality: the five documented input shapes ────────────────────────

describe('MAIN: the five documented input shapes normalize', () => {
  test('raw axe AxeResults -> one violation per Result x NodeResult pair', () => {
    const doc = {
      testEngine: { name: 'axe-core', version: '4.13.0' },
      url: 'http://127.0.0.1:5174/dashboard',
      timestamp: '2026-09-12T00:00:00.000Z',
      violations: [{
        id: 'button-name', impact: 'critical', tags: ['wcag2a', 'wcag412', 'cat.name-role-value'],
        description: 'Buttons must have discernible text', help: 'Buttons must have discernible text',
        helpUrl: 'https://example/button-name',
        nodes: [
          { target: ['#a'], html: '<button id="a"></button>', failureSummary: 'Fix any of:\n  no text' },
          { target: ['#b'], html: '<button id="b"></button>' },
        ],
      }],
    };
    const out = N.normalizeScan(doc, { appUrl: 'http://x/' });
    assert.equal(out.schema_version, '1.0');
    assert.equal(out.violations.length, 2);
    assert.equal(out.violations[0].id, 'button-name#0');
    assert.equal(out.violations[1].id, 'button-name#1');
    assert.equal(out.violations[0].rule_id, 'button-name');
    assert.equal(out.violations[0].selector, '#a');
    assert.equal(out.violations[0].route, '/dashboard', 'route comes from the axe doc url');
    assert.deepEqual(out.violations[0].wcag, ['wcag2a', 'wcag412'], 'only wcag* tags kept');
    assert.equal(out.violations[0].help, 'Fix any of: no text', 'failureSummary whitespace-collapsed');
    assert.equal(out.scan.tool, 'axe-core@4.13.0');
  });

  test('bare axe Result[] array normalizes', () => {
    const doc = [{ id: 'label', tags: ['wcag2a'], nodes: [{ target: ['#e'], html: '<input id="e">' }] }];
    const out = N.normalizeScan(doc, { appUrl: 'http://h/p' });
    assert.equal(out.violations.length, 1);
    assert.equal(out.violations[0].id, 'label#0');
    assert.equal(out.violations[0].route, '/p');
  });

  test('a single axe Result picks its first node via pickViolation', () => {
    const doc = { id: 'label', tags: [], nodes: [{ target: ['#e'], html: '<input>' }, { target: ['#f'], html: '<input>' }] };
    const { violation } = N.pickViolation(doc, undefined, { appUrl: 'http://h/' });
    assert.equal(violation.id, 'label#0');
    assert.equal(violation.selector, '#e');
  });

  test('schema-1.0 document passes through with its content intact', () => {
    const doc = {
      schema_version: '1.0',
      scan: { tool: 't', app_url: 'u', timestamp: 'ts' },
      violations: [{ id: 'label#0', rule_id: 'label', selector: '#e', html: '', description: '', route: '/', impact: 'critical', source_tool: 'axe' }],
    };
    const before = JSON.stringify(doc);
    const out = N.normalizeScan(doc);
    assert.deepEqual(out.violations, doc.violations, 'violations survive verbatim');
    assert.deepEqual(out.scan, doc.scan);
    assert.equal(out.schema_version, '1.0');
    assert.equal(JSON.stringify(doc), before, 'and the input is not mutated');
    assert.notEqual(out.violations, doc.violations,
      'a copy is returned so callers cannot mutate the caller\'s document through the result');
  });

  test("MongoDB scans document maps severity->impact and source_file->source", () => {
    const doc = {
      _id: { $oid: '65f000000000000000000001' },
      target_app: 'portal', timestamp: '2026-09-12',
      violations: [{ rule_id: 'label', selector: '#student-email', severity: 'high', description: 'no label', source_file: 'src/EnrollForm.jsx' }],
    };
    const out = N.normalizeScan(doc, { appUrl: 'http://h/' });
    assert.equal(out.scan.mongo_scan_id, '65f000000000000000000001');
    assert.equal(out.scan.target_app, 'portal');
    assert.equal(out.violations[0].impact, 'serious', 'high -> serious');
    assert.deepEqual(out.violations[0].source, { file: 'src/EnrollForm.jsx', line: undefined });
  });
});

describe('MAIN: pickViolation selection modes', () => {
  const scan = {
    schema_version: '1.0', scan: {},
    violations: [
      { id: 'label#0', rule_id: 'label', selector: '#a' },
      { id: 'label#1', rule_id: 'label', selector: '#b' },
      { id: 'button-name#0', rule_id: 'button-name', selector: '#c' },
    ],
  };
  test('--id rule#index selects exactly', () => {
    assert.equal(N.pickViolation(scan, 'label#1').violation.selector, '#b');
  });
  test('--id bare rule selects the first node of that rule', () => {
    assert.equal(N.pickViolation(scan, 'label').violation.id, 'label#0');
  });
  test('--id CSS selector selects by selector', () => {
    assert.equal(N.pickViolation(scan, '#c').violation.id, 'button-name#0');
  });
  test('unknown --id throws with the available list', () => {
    assert.throws(() => N.pickViolation(scan, 'nope'), /not found.*label#0, label#1, button-name#0/s);
  });
  test('multi-violation input with no --id throws asking for one', () => {
    assert.throws(() => N.pickViolation(scan, undefined), /pass --id/);
  });
});

// ── Easy cases ─────────────────────────────────────────────────────────────────

describe('EASY: severity mapping table', () => {
  for (const [sev, want] of [['low', 'minor'], ['minor', 'minor'], ['medium', 'moderate'], ['moderate', 'moderate'],
                             ['high', 'serious'], ['serious', 'serious'], ['critical', 'critical']]) {
    test(`severity ${sev} -> impact ${want}`, () => {
      assert.equal(N.mongoViolationToOurs({ rule_id: 'r', selector: '#s', severity: sev }).impact, want);
    });
  }
  test('unknown severity with no impact falls back to "unknown"', () => {
    assert.equal(N.mongoViolationToOurs({ rule_id: 'r', selector: '#s', severity: 'spicy' }).impact, 'unknown');
  });
  test('severity is case-insensitive', () => {
    assert.equal(N.mongoViolationToOurs({ rule_id: 'r', selector: '#s', severity: 'HIGH' }).impact, 'serious');
  });
});

describe('EASY: shadow-DOM and multi-part selectors flatten', () => {
  test('nested CrossTreeSelector arrays join with >>>', () => {
    const v = N.axeResultToViolations({ id: 'r', nodes: [{ target: [['#host', '#inner'], '#tail'] }] })[0];
    assert.equal(v.selector, '#host >>> #inner #tail');
  });
  test('a plain string target is stringified', () => {
    const v = N.axeResultToViolations({ id: 'r', nodes: [{ target: '#only' }] })[0];
    assert.equal(v.selector, '#only');
  });
});

// ── Edge cases ─────────────────────────────────────────────────────────────────

describe('EDGE: empty and missing', () => {
  test('an axe Result with zero nodes yields zero violations', () => {
    assert.deepEqual(N.axeResultToViolations({ id: 'r', nodes: [] }), []);
  });
  test('pickViolation on a single axe Result with no nodes throws a clear error', () => {
    assert.throws(() => N.pickViolation({ id: 'r', nodes: [] }), /has no nodes/);
  });
  test('a clean scan (violations: []) normalizes to an empty violation list, not an error', () => {
    const out = N.normalizeScan({ schema_version: '1.0', scan: {}, violations: [] });
    assert.deepEqual(out.violations, []);
  });
  test('missing target yields an empty-string selector rather than throwing', () => {
    const v = N.axeResultToViolations({ id: 'r', nodes: [{}] })[0];
    assert.equal(v.selector, '');
  });
  test('normalizeScan on an unrecognised document throws a descriptive error', () => {
    assert.throws(() => N.normalizeScan({ hello: 'world' }), /unrecognized scan document/);
  });
  test('normalizeScan(null) throws rather than returning a broken doc', () => {
    assert.throws(() => N.normalizeScan(null));
  });
  test('routeOf tolerates a malformed app url (falls back to /)', () => {
    const out = N.normalizeScan([{ id: 'r', nodes: [{ target: ['#a'] }] }], { appUrl: 'not a url' });
    assert.equal(out.violations[0].route, '/');
  });
});

describe('EDGE: selector is the violation identity — it must never be undefined', () => {
  // verify.mjs keys violations as `${rule_id}|${selector}`. A violation whose selector is
  // undefined stringifies to "rule|undefined", which silently matches any other selector-less
  // violation of the same rule.
  test('a schema-1.0 doc whose violations lack `selector` still normalizes — selector is undefined', () => {
    const doc = { schema_version: '1.0', scan: {}, violations: [{ rule_id: 'label', description: 'x' }] };
    const out = N.normalizeScan(doc);
    assert.notEqual(out.violations[0].selector, undefined,
      'a normalized violation must always carry a selector: it is half of the identity key');
  });
});

describe('EDGE: empty-array discriminators', () => {
  // `[].every(pred)` is true, so an empty violations array satisfies every shape predicate.
  test('isOurDoc({violations: []}) is true only if that is intended', () => {
    assert.equal(N.isOurDoc({ violations: [] }), true);
  });
  test('a document with an empty violations array and no other marker is classified deterministically', () => {
    const out = N.normalizeScan({ violations: [] }, { appUrl: 'http://h/' });
    assert.equal(out.violations.length, 0);
    assert.equal(out.scan.tool, 'unknown', 'an unmarked empty doc should fall through to the generic branch');
  });
});

describe('EDGE: mongo _id shapes', () => {
  test('extended-JSON {$oid} is unwrapped', () => {
    const out = N.normalizeScan({ target_app: 'a', violations: [], _id: { $oid: 'abc' } });
    assert.equal(out.scan.mongo_scan_id, 'abc');
  });
  test('a plain string _id is preserved', () => {
    const out = N.normalizeScan({ target_app: 'a', violations: [], _id: 'plain-id' });
    assert.equal(out.scan.mongo_scan_id, 'plain-id');
  });
  test('a BSON-like ObjectId object stringifies to its hex, not "[object Object]"', () => {
    class ObjectId { constructor(h) { this.h = h; } toString() { return this.h; } }
    const out = N.normalizeScan({ target_app: 'a', violations: [], _id: new ObjectId('deadbeef') });
    assert.equal(out.scan.mongo_scan_id, 'deadbeef');
  });
});

// ── Hard / adversarial cases ───────────────────────────────────────────────────

describe('HARD: ambiguous documents must not be misrouted', () => {
  test('a Mongo scans doc whose violations also carry impact+html is still treated as Mongo', () => {
    // isMongoViolation excludes anything with BOTH impact and html, so a hybrid document
    // (a Mongo doc enriched with axe fields) falls through to a different branch.
    const doc = {
      target_app: 'portal',
      violations: [{ rule_id: 'label', selector: '#e', severity: 'high', source_file: 'a.jsx', impact: 'critical', html: '<input>' }],
    };
    const out = N.normalizeScan(doc, { appUrl: 'http://h/' });
    assert.equal(out.scan.target_app, 'portal', 'target_app must survive; losing it breaks the Mongo bridge');
  });

  test('an axe doc that also has target_app is not stolen by the Mongo branch', () => {
    const doc = {
      target_app: 'portal', testEngine: { name: 'axe-core', version: '4.13.0' },
      violations: [{ id: 'label', tags: [], nodes: [{ target: ['#e'], html: '<input>' }] }],
    };
    const out = N.normalizeScan(doc, { appUrl: 'http://h/' });
    assert.equal(out.violations[0].rule_id, 'label');
    assert.equal(out.violations[0].selector, '#e', 'axe nodes must be expanded, not passed through raw');
  });

  test('a single Mongo violation object (not a document) is accepted by pickViolation', () => {
    const v = { rule_id: 'label', selector: '#e', severity: 'high', source_file: 'a.jsx' };
    const { violation } = N.pickViolation(v, undefined, { appUrl: 'http://h/' });
    assert.equal(violation.rule_id, 'label');
    assert.equal(violation.impact, 'serious');
    assert.deepEqual(violation.source, { file: 'a.jsx', line: undefined });
  });
});

describe('HARD: hostile JSON', () => {
  test('a __proto__ key in a violation does not pollute Object.prototype', () => {
    const doc = JSON.parse('{"schema_version":"1.0","scan":{},"violations":[{"rule_id":"r","selector":"#s","__proto__":{"polluted":"yes"}}]}');
    N.normalizeScan(doc);
    assert.equal({}.polluted, undefined, 'prototype must not be polluted');
  });

  test('a violations value that is not an array is rejected, not coerced', () => {
    assert.throws(() => N.normalizeScan({ violations: 'not-an-array' }), /unrecognized scan document/);
  });

  test('deeply nested target arrays do not blow the stack', () => {
    let t = ['#leaf'];
    for (let i = 0; i < 500; i++) t = [t];
    const v = N.axeResultToViolations({ id: 'r', nodes: [{ target: t }] })[0];
    assert.equal(typeof v.selector, 'string');
  });

  test('a violation id colliding across rules stays distinguishable by rule_id+selector', () => {
    const doc = {
      schema_version: '1.0', scan: {},
      violations: [
        { id: 'dup#0', rule_id: 'label', selector: '#a' },
        { id: 'dup#0', rule_id: 'button-name', selector: '#a' },
      ],
    };
    // pickViolation by id returns the FIRST match; the two are only separable by rule_id.
    assert.equal(N.pickViolation(doc, 'dup#0').violation.rule_id, 'label');
    assert.equal(N.pickViolation(doc, 'button-name').violation.rule_id, 'button-name');
  });

  test('normalizeScan never mutates its input (documented contract)', () => {
    const doc = {
      target_app: 'portal',
      violations: [{ rule_id: 'label', selector: '#e', severity: 'high', source_file: 'a.jsx' }],
    };
    const before = JSON.stringify(doc);
    N.normalizeScan(doc, { appUrl: 'http://h/' });
    assert.equal(JSON.stringify(doc), before, 'input document must be untouched');
  });
});
