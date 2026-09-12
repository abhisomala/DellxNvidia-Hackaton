/**
 * Map a violation (selector + rendered HTML) to the source file and line that produced it.
 * Uses violation.source when Path 1 supplies it; otherwise scores every source file by token hits.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

function escapeRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function tokensFor(v) {
  const t = { ids: [], classes: [], text: [], attrs: [] };
  const idFromSel = (sel) => { const m = /#([A-Za-z0-9_:\-]+)/.exec(sel || ''); return m ? m[1].replace(/\\/g, '') : null; };
  const selId = idFromSel(v.selector); if (selId) t.ids.push(selId);
  const html = v.html || '';
  for (const m of html.matchAll(/\bid=["']([^"']+)["']/g)) if (!t.ids.includes(m[1])) t.ids.push(m[1]);
  for (const m of html.matchAll(/\bclass=["']([^"']+)["']/g)) for (const c of m[1].split(/\s+/)) if (c && !t.classes.includes(c)) t.classes.push(c);
  for (const m of html.matchAll(/\b(data-[a-z0-9-]+|aria-[a-z]+|name|placeholder|type)=["']([^"']+)["']/g)) t.attrs.push(`${m[1]}=${m[2]}`);
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length >= 3) t.text.push(text.slice(0, 60));
  if (v.repro?.open_selector) { const oid = idFromSel(v.repro.open_selector); if (oid && !t.ids.includes(oid)) t.ids.push(oid); }
  return t;
}

const RULE_BOOSTS = [
  { test: (rule) => /^keyboard-|focus/.test(rule), rx: /keydown|KeyboardEvent|\.focus\(|activeElement|tabindex/i, bonus: 12 },
];

function scoreFile(content, t, rule = '') {
  let score = 0; let line = null;
  for (const b of RULE_BOOSTS) if (b.test(rule) && b.rx.test(content)) { score += b.bonus; const i = content.split('\n').findIndex((l) => b.rx.test(l)); if (i >= 0) line = i + 1; }
  const lines = content.split('\n');
  const find = (rx) => lines.findIndex((l) => rx.test(l));
  for (const id of t.ids) {
    const rx = new RegExp(`\\bid\\s*=\\s*["'{\`]\\s*${escapeRx(id)}\\s*["'}\`]|htmlFor\\s*=\\s*["']${escapeRx(id)}["']|#${escapeRx(id)}\\b`);
    const i = find(rx);
    if (i >= 0) { score += 10; if (line == null) line = i + 1; }
  }
  for (const c of t.classes) {
    const rx = new RegExp(`class(Name)?\\s*=\\s*["'{\`][^"'}\`]*\\b${escapeRx(c)}\\b`);
    const i = find(rx);
    if (i >= 0) { score += 2; if (line == null) line = i + 1; }
  }
  for (const a of t.attrs) {
    const [k, val] = a.split('=');
    const rx = new RegExp(`\\b${escapeRx(k)}\\s*=\\s*["'{\`]\\s*${escapeRx(val)}`);
    const i = find(rx);
    if (i >= 0) { score += 1; if (line == null) line = i + 1; }
  }
  for (const tx of t.text) {
    const words = tx.split(' ').filter((w) => w.length > 2).slice(0, 4);
    if (words.length && find(new RegExp(words.map(escapeRx).join('\\s+'))) >= 0) { score += 3; if (line == null) line = find(new RegExp(escapeRx(words[0]))) + 1; }
  }
  return { score, line };
}

export function numbered(content, from = 1) {
  return content.split('\n').map((l, i) => `${String(from + i).padStart(4, ' ')}| ${l}`).join('\n');
}

/** Returns { file, line, snippet, snippetFrom, snippetTo, method, candidates } */
export async function locate(app, v, { maxWholeFile = 220, window = 40, maxRelatedBytes = 8000, maxSnippetBytes = 60000 } = {}) {
  const t = tokensFor(v);
  let file = null, line = null, method = 'search', candidates = [];
  if (v.source?.file && (app.local ? existsSync(join(app.root, v.source.file)) : true)) {
    file = v.source.file; line = v.source.line || null; method = 'provided';
  }
  const files = await app.listSourceFiles();
  const scored = [];
  for (const f of files) {
    let content;
    try { content = await app.readFile(f); } catch { continue; }
    const s = scoreFile(content, t, v.rule_id);
    if (s.score > 0) scored.push({ file: f, ...s });
  }
  scored.sort((a, b) => b.score - a.score || a.file.length - b.file.length);
  candidates = scored.slice(0, 5);
  if (!file) {
    if (!scored.length) throw new Error(`could not locate source for ${v.id}: no file matches tokens ${JSON.stringify(t)}`);
    file = scored[0].file; line = scored[0].line;
  } else if (line == null) {
    const hit = scored.find((s) => s.file === file); if (hit) line = hit.line;
  }
  const related = [];
  for (const c of scored.filter((x) => x.file !== file).slice(0, 2)) {
    try {
      const txt = await app.readFile(c.file);
      const ls = txt.split('\n');
      // Cap by BYTES as well as lines: a one-line minified bundle passes any line-count test
      // and would be embedded whole (twice, counting the main file).
      if (ls.length <= 200 && txt.length <= maxRelatedBytes) related.push({ file: c.file, line: c.line, snippet: txt, totalLines: ls.length });
    } catch {}
  }
  const content = await app.readFile(file);
  const lines = content.split('\n');
  let from = 1, to = lines.length;
  if (lines.length > maxWholeFile && line) { from = Math.max(1, line - window); to = Math.min(lines.length, line + window); }
  let snippet = lines.slice(from - 1, to).join('\n'); // exact text, no prefixes: the agent's edit tool needs verbatim old-text
  let truncated = false;
  if (snippet.length > maxSnippetBytes) { snippet = snippet.slice(0, maxSnippetBytes); truncated = true; }
  return { file, line, snippet, snippetFrom: from, snippetTo: to, totalLines: lines.length, truncated, method, tokens: t, candidates, related };
}
