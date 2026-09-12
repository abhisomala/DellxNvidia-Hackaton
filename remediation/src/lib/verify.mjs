import { run, fill } from './proc.mjs';
import { GUIDANCE } from './prompt.mjs';
import { normalizeScan } from './normalize.mjs';

/** Deterministic guard: a single-rule fix must stay small and local. */
export function guardDiff(o, diff, changedFiles) {
  const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const removed = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
  const reasons = [];
  if (added > o.maxAddedLines) reasons.push(`the change adds ${added} lines; a fix for one rule must add at most ${o.maxAddedLines}. Make a minimal edit instead of rewriting or duplicating code.`);
  if (removed > (o.maxRemovedLines ?? 40)) reasons.push(`the change removes ${removed} lines; a fix must not delete existing code (at most ${o.maxRemovedLines ?? 40} removed lines). Keep every existing element, handler and line unless it is the one you are fixing.`);
  if (changedFiles.length > o.maxFiles) reasons.push(`the change touches ${changedFiles.length} files (${changedFiles.join(', ')}); touch at most ${o.maxFiles}.`);
  return { ok: reasons.length === 0, added, removed, files: changedFiles.length, reasons };
}

/** Read-only reviewer: a second model pass over the diff (no tools, no file access). */
export async function judge(o, { violation, diff }, { log = () => {} } = {}) {
  if (!o.judgeUrl) return { skipped: true, ok: true, reasons: [] };
  const g = GUIDANCE[violation.rule_id];
  const system = 'You are a strict senior reviewer for accessibility fixes in a web codebase. You only review; you never rewrite. Answer with a single JSON object and nothing else.';
  const user = [
    `A coding agent was asked to fix exactly one accessibility violation with a minimal source change.`,
    `Violation: rule ${violation.rule_id} (${violation.description}) at ${violation.selector}; rendered element: ${violation.html}`,
    g ? `Expected kind of fix: ${g.fix}` : '',
    'Review the diff below against these rules:',
    '1. It addresses only this violation with a minimal, idiomatic change (React/JSX or HTML/CSS).',
    '2. It removes or renames NO existing element, id, attribute, prop, state, or event handler; existing buttons/inputs keep their ids and behavior.',
    '3. It introduces NO duplicated or unreachable code (for example a second return statement, a copied JSX block, or a function body left after a return).',
    '4. Any control it adds is real and usable: not hidden with display:none/visibility:hidden/aria-hidden, not disabled, reachable by keyboard, AND wired to a handler that does what its label says (a <button>Close</button> with no onClick/close logic is a dead control and FAILS this rule).',
    '5. It is syntactically valid and would not throw at runtime.',
    'Reply ONLY with JSON: {"verdict":"pass"|"fail","reasons":["..."]} where reasons lists every violated rule in one sentence each (empty if pass).',
    '```diff', diff.slice(0, 12000), '```',
  ].filter(Boolean).join('\n');
  const body = { model: o.judgeModel, temperature: 0, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 800 };
  log(`judge: ${o.judgeUrl} model=${o.judgeModel}`);
  const t0 = Date.now();
  let text = '';
  try {
    const res = await fetch(`${o.judgeUrl.replace(/\/+$/, '')}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${o.judgeKey || 'unused'}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
    const json = await res.json();
    text = json.choices?.[0]?.message?.content ?? JSON.stringify(json);
  } catch (e) {
    return { ok: true, skipped: true, error: `judge unavailable: ${e.message}`, reasons: [] };
  }
  const clean = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const m = clean.match(/\{[\s\S]*\}/);
  let verdict = { verdict: 'pass', reasons: [] };
  try { if (m) verdict = JSON.parse(m[0]); } catch { verdict = { verdict: 'pass', reasons: [], unparsed: clean.slice(0, 300) }; }
  const ok = String(verdict.verdict).toLowerCase() !== 'fail';
  return { ok, reasons: Array.isArray(verdict.reasons) ? verdict.reasons.map(String) : [], raw: clean.slice(0, 1500), ms: Date.now() - t0 };
}

export const key = (v) => `${v.rule_id}|${v.selector}`;

export async function runScan(o, { log = () => {} } = {}) {
  const cmd = fill(o.scanCmd, { url: o.url, appRoot: o.appRoot });
  log(`scan: ${cmd}`);
  const r = await run(cmd, { shell: true, timeoutMs: 180000 });
  if (r.code !== 0) throw new Error(`scanner exited ${r.code}: ${r.stderr.slice(-1500)}`);
  const s = r.stdout.trim();
  const start = s.indexOf('{');
  const first = Math.min(...[s.indexOf('{'), s.indexOf('[')].filter((i) => i >= 0));
  const doc = normalizeScan(JSON.parse(s.slice(first)), { appUrl: o.url });
  return doc;
}

export function compareScans(baseline, after, target) {
  const baseKeys = new Set(baseline.violations.map(key));
  const targetKey = key(target);
  const targetGone = !after.violations.some((v) => key(v) === targetKey);
  const remainingSameRule = after.violations.filter((v) => v.rule_id === target.rule_id).map((v) => ({ selector: v.selector, html: v.html, help: v.help }));
  const newViolations = after.violations.filter((v) => !baseKeys.has(key(v))).map((v) => ({ id: v.id, rule_id: v.rule_id, selector: v.selector, help: v.help, description: v.description }));
  const fixedOthers = [...baseKeys].filter((k) => k !== targetKey && !after.violations.some((v) => key(v) === k));
  return { targetGone, remainingSameRule, newViolations, fixedOthers, before: baseline.violations.length, after: after.violations.length };
}

export async function runFunctional(o, { log = () => {} } = {}) {
  if (!o.funcCmd) return { passed: true, skipped: true, output: '' };
  const cmd = fill(o.funcCmd, { url: o.url, appRoot: o.appRoot });
  log(`functional: ${cmd}`);
  const r = await run(cmd, { shell: true, timeoutMs: 180000 });
  return { passed: r.code === 0, code: r.code, output: (r.stdout + (r.stderr ? '\n' + r.stderr : '')).trim().slice(-4000) };
}

/** Full verification: build -> rescan (target gone, no new violations) -> functional. */
export async function verify(o, app, baseline, target, { log = () => {}, diff = '', changedFiles = [] } = {}) {
  const out = { ok: false };
  out.guard = guardDiff(o, diff, changedFiles);
  if (!out.guard.ok) { log(`guard failed: ${out.guard.reasons.join(' | ')}`); return out; }
  const b = await app.build(o.buildCmd);
  out.build = { ok: b.code === 0, skipped: !!b.skipped, output: (b.stdout + '\n' + b.stderr).trim().slice(-3000) };
  if (!out.build.ok) { log('build failed'); return out; }
  const after = await runScan(o, { log });
  out.scan = compareScans(baseline, after, target);
  out.scan.doc = after;
  out.functional = await runFunctional(o, { log });
  const objective = out.build.ok && out.scan.targetGone && out.scan.newViolations.length === 0 && out.functional.passed;
  if (!objective) return out;
  out.judge = await judge(o, { violation: target, diff }, { log });
  if (!out.judge.ok) log(`judge failed: ${out.judge.reasons.join(' | ')}`);
  out.ok = out.judge.ok;
  return out;
}
