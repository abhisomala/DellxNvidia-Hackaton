import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const GUIDANCE = JSON.parse(readFileSync(join(here, '..', '..', 'rules', 'guidance.json'), 'utf8'));

/** Scanner- and model-supplied strings are size-capped before they reach the prompt. */
const MAX_HTML = 2000;
const MAX_HELP = 2000;
const MAX_RELATED = 8000;
export function clip(s, max) {
  const str = String(s ?? '');
  return str.length <= max ? str : `${str.slice(0, max)}\n... [truncated ${str.length - max} more characters]`;
}

export function buildFixPrompt({ violation: v, location: loc, agentAppRoot, functionalHint }) {
  const g = GUIDANCE[v.rule_id];
  const absFile = `${agentAppRoot.replace(/\/+$/, '')}/${loc.file}`;
  const lines = [];
  lines.push(`You are A11yClaw, an accessibility remediation engineer. You are working in a git checkout of a web app at ${agentAppRoot}.`);
  lines.push(`Your job: fix exactly ONE accessibility violation by editing source files with your file tools (read, edit, write). Do not start servers, do not install packages, do not run git commands, do not commit.`);
  lines.push('');
  lines.push('## Violation');
  lines.push(`- rule_id: ${v.rule_id} (reported by ${v.source_tool || 'scanner'}), impact: ${v.impact || 'unknown'}, WCAG tags: ${(v.wcag || []).join(', ') || 'n/a'}`);
  lines.push(`- description: ${v.description || ''}`);
  if (v.help) lines.push(`- failure summary: ${clip(v.help, MAX_HELP)}`);
  if (v.help_url) lines.push(`- reference: ${v.help_url}`);
  lines.push(`- page route: ${v.route || '/'}`);
  lines.push(`- CSS selector of the failing element: ${v.selector}`);
  // Scanner-supplied; never trusted for size. A single huge element (or a minified blob) would
  // otherwise be interpolated raw and dominate the prompt.
  if (v.html) lines.push(`- rendered HTML of the failing element: ${clip(v.html, MAX_HTML)}`);
  if (v.repro) {
    lines.push(`- how it was reproduced: opened via ${v.repro.open_selector || '?'} then pressed ${(v.repro.keys || []).join(', ')}; observed: ${v.repro.observed || ''}`);
  }
  lines.push('');
  lines.push('## Where it comes from');
  lines.push(`File: ${absFile}${loc.line ? ` (the element is around line ${loc.line})` : ''}${loc.method === 'search' ? ' - located by matching the element\'s id/class/text against the source' : ''}`);
  lines.push(loc.snippetFrom === 1 && loc.snippetTo === loc.totalLines ? 'Exact current content of the file (verbatim, so you can copy old text for your edit tool exactly, including indentation):' : `Exact current content of lines ${loc.snippetFrom}-${loc.snippetTo} of ${loc.totalLines} (verbatim, including indentation):`);
  lines.push('```');
  lines.push(loc.snippet);
  lines.push('```');
  for (const r of loc.related || []) {
    const abs = `${agentAppRoot.replace(/\/+$/, '')}/${r.file}`;
    lines.push('');
    lines.push(`Related file that also references this element (the right place to edit may be here instead): ${abs}`);
    lines.push('```');
    lines.push(clip(r.snippet, MAX_RELATED));
    lines.push('```');
  }
  lines.push('');
  lines.push('## How to fix this rule');
  lines.push(g ? g.fix : 'Apply the standard remediation for this rule per the reference link, using semantic HTML first and ARIA only where needed.');
  lines.push('');
  lines.push('## How to work');
  lines.push(`- Step 1: call your read tool on ${absFile} to see the current content.`);
  lines.push('- Step 2: call your edit tool (or write tool) to change that file. Copy the old text EXACTLY from the file content (same indentation, same line breaks); if the edit tool reports that the old text does not match, do NOT guess again: write the complete corrected file with your write tool instead (keep every other line identical). The change must be applied to disk by a tool call; describing a change without making it counts as no change and fails the task.');
  lines.push('- Step 3: reply with the summary described below.');
  lines.push('');
  lines.push('## Hard requirements');
  lines.push('1. Make the smallest source change that resolves this rule for this element. Do not refactor, reformat, rename, or touch unrelated code.');
  lines.push('2. Preserve behavior exactly: keep every existing id, className, type, prop, state, and event handler (onClick, onSubmit, onChange, onKeyDown...). Automated functional tests will click the same ids and expect the same results.' + (functionalHint ? ` ${functionalHint}` : ''));
  lines.push('3. Edit the file in place with your edit/write tool. Keep the file syntactically valid (it is compiled by Vite; a syntax error fails the build).');
  lines.push('4. Do not add dependencies or new files unless the fix is impossible otherwise.');
  lines.push('5. When done, reply with ONLY: one line summarizing the change, then one line per file changed as "changed: <path>". Do not paste the file contents.');
  return lines.join('\n');
}

export function buildRetryPrompt({ violation: v, location: loc, agentAppRoot, attempt, previous }) {
  const base = buildFixPrompt({ violation: v, location: loc, agentAppRoot });
  const fb = [];
  fb.push('');
  fb.push(`## Feedback from attempt ${attempt - 1} (this is attempt ${attempt})`);
  if (previous.diff && previous.diff.trim()) {
    fb.push('Your previous edit is still applied. Here is the current diff against the original source:');
    fb.push('```diff');
    fb.push(previous.diff.slice(0, 6000));
    fb.push('```');
  } else {
    fb.push('Your previous turn changed NO files on disk (git diff is empty), even though you may have described a change. You must call the edit or write tool on the file so the change is actually applied. Do it now.');
  }
  const vr = previous.verify || {};
  if (vr.guard && vr.guard.ok === false) fb.push(`Your edit was REJECTED before testing: ${vr.guard.reasons.join(' ')}`);
  if (vr.judge && vr.judge.ok === false) fb.push(`Your edit passed the tests but a code review REJECTED it for these reasons: ${vr.judge.reasons.map((r) => `(${r})`).join(' ')} Produce a clean, minimal edit that fixes the violation without these problems.`);
  if (vr.build && vr.build.ok === false) fb.push(`The build FAILED after your edit:\n\`\`\`\n${(vr.build.output || '').slice(0, 2000)}\n\`\`\``);
  if (vr.scan) {
    if (vr.scan.targetGone === false) {
      fb.push(`The scanner still reports rule ${v.rule_id} at ${v.selector} AFTER your edit, so your change did not satisfy the rule.` + (vr.scan.remainingSameRule?.length ? ` Current failing element(s): ${vr.scan.remainingSameRule.map((r) => `${r.selector} => ${r.html}${r.help ? ` -- scanner says: ${r.help}` : ''}`).join(' ; ')}` : ''));
    }
    if (vr.scan.newViolations?.length) {
      fb.push(`Your edit introduced NEW violations that were not there before: ${vr.scan.newViolations.map((r) => `${r.rule_id} at ${r.selector} (${r.help || r.description})`).join(' ; ')}. Fix the original issue without introducing these.`);
    }
  }
  if (vr.functional && vr.functional.passed === false) {
    fb.push(`The functional check FAILED after your edit (behavior must not change):\n\`\`\`\n${(vr.functional.output || '').slice(0, 2000)}\n\`\`\``);
    fb.push('Re-read the exact line you edited in the diff above and check it is well-formed: balanced quotes, every attribute still present and spelled as before (a stray quote or a broken data-/class attribute silently disables the behavior).');
  }
  if (previous.unchanged) fb.push('IMPORTANT: your last edit was IDENTICAL to the one before it, and it was already rejected. Repeating it will be rejected again. Choose a different remediation that addresses the scanner message above.');
  fb.push('Adjust the fix accordingly. Keep what already works; change only what is needed.');
  return base + '\n' + fb.join('\n');
}
