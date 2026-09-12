#!/usr/bin/env node
// Keyboard probe: Path 1's companion to a11y-scan.js for what axe-core cannot see.
// Opens every dialog on the page with a real click, drives it with real Tab /
// Shift+Tab / Escape key presses in Chromium, and reports controls the keyboard
// never reaches (keyboard-unreachable, WCAG 2.1.1) and dialogs Escape does not
// close (keyboard-trap, WCAG 2.1.2). The JSON report is axe-shaped so
// db/axe_adapter.py ingests it unchanged.
//
// Usage: node scripts/keyboard-scan.js <target file or URL> [--out <path>]
// Exit: 0 = no violations, 1 = violations found, 2 = harness error (the probe did not run).

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DEFAULT_TARGET = path.join(__dirname, '..', 'demo', 'index.html');
const DEFAULT_OUT = path.join(__dirname, '..', 'reports', 'keyboard-report.json');

const DIALOG_SELECTOR = '[role="dialog"], dialog, [aria-modal="true"]';
const FOCUSABLE_SELECTOR =
  'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
const PREFERRED_OPENER_SELECTOR = '[data-open-modal], [aria-haspopup="dialog"], [aria-controls]';
const MAX_OPENER_CANDIDATES = 50;

const LAUNCH_TIMEOUT_MS = 30000;
const GOTO_TIMEOUT_MS = 15000;
const ACTION_TIMEOUT_MS = 5000;
const CLICK_TIMEOUT_MS = 3000;
const OPEN_WAIT_MS = 1500;
const CLOSE_WAIT_MS = 1000;
const WATCHDOG_MS = 180000;

const UNREACHABLE_HELP_URL = 'https://www.w3.org/WAI/WCAG21/Understanding/keyboard.html';
const TRAP_HELP_URL = 'https://www.w3.org/WAI/WCAG21/Understanding/no-keyboard-trap.html';

class HarnessError extends Error {}

function toFileUrl(filePath) {
  return 'file://' + path.resolve(filePath);
}

function parseArgs(argv) {
  let target = null;
  let out = DEFAULT_OUT;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      if (!argv[i + 1]) throw new HarnessError('--out needs a path');
      out = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--out=')) {
      out = arg.slice('--out='.length);
      if (!out) throw new HarnessError('--out needs a path');
    } else if (arg.startsWith('--')) {
      throw new HarnessError(`unknown option ${arg}`);
    } else if (target === null) {
      target = arg;
    } else {
      throw new HarnessError(`unexpected argument ${arg}`);
    }
  }
  return { target: target || DEFAULT_TARGET, out: path.resolve(out) };
}

function resolveUrl(target) {
  if (/^(https?|file):\/\//.test(target)) return target;
  if (!fs.existsSync(target)) throw new HarnessError(`target file not found: ${target}`);
  return toFileUrl(target);
}

// ---------------------------------------------------------------------------
// In-page helpers. Installed once per fresh page load; state lives on
// window.__kbProbe so no attributes are written into the page's own DOM.
// ---------------------------------------------------------------------------
function installHelpers({ dialogSelector, focusableSelector, preferredSelector, maxCandidates }) {
  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    if (typeof el.checkVisibility === 'function' &&
        !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const segment = (el) => {
    let seg = el.tagName.toLowerCase();
    for (const cls of el.classList) seg += '.' + CSS.escape(cls);
    const parent = el.parentElement;
    if (parent) {
      const same = [...parent.children].filter((c) => c.tagName === el.tagName);
      const alike = same.filter((c) => c.matches(seg));
      if (alike.length > 1) seg += `:nth-of-type(${same.indexOf(el) + 1})`;
    }
    return seg;
  };

  const isUniqueId = (el) =>
    el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1;

  // Shortest unique "a > b > c" path, anchored at an id ancestor when one exists.
  const selectorFor = (el) => {
    if (!el || el.nodeType !== 1) return '(none)';
    if (isUniqueId(el)) return '#' + CSS.escape(el.id);
    const parts = [segment(el)];
    let cur = el;
    while (document.querySelectorAll(parts.join(' > ')).length !== 1 && cur.parentElement) {
      cur = cur.parentElement;
      if (isUniqueId(cur)) { parts.unshift('#' + CSS.escape(cur.id)); break; }
      parts.unshift(segment(cur));
    }
    return parts.join(' > ');
  };

  const textFor = (el) => {
    if (!el || el.nodeType !== 1) return '';
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    const label = text || el.getAttribute('aria-label') || el.getAttribute('title') ||
      (typeof el.value === 'string' ? el.value : '') || '';
    return label.length > 60 ? label.slice(0, 57) + '...' : label;
  };

  const openingTag = (el) => {
    const attrs = [...el.attributes]
      .map((a) => ` ${a.name}="${a.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`)
      .join('');
    return `<${el.tagName.toLowerCase()}${attrs}>`;
  };

  // Outermost matches only: a <div aria-modal> wrapping a [role=dialog] is one dialog.
  const matched = [...document.querySelectorAll(dialogSelector)];
  const dialogs = matched.filter((el) => !matched.some((o) => o !== el && o.contains(el)));

  // Report container: climb through pure wrappers (single element child) to an id.
  const containerFor = (dialog) => {
    let cur = dialog;
    while (cur) {
      if (isUniqueId(cur)) return cur;
      const parent = cur.parentElement;
      if (!parent || parent === document.body || parent.children.length !== 1) break;
      cur = parent;
    }
    return dialog;
  };

  const insideAnyDialog = (el) => dialogs.some((d) => d.contains(el));
  const enabled = (el) => !el.disabled && !(el.tagName === 'INPUT' && el.type === 'hidden');

  const candidates = (() => {
    const preferred = [...document.querySelectorAll(
      preferredSelector.split(',').map((s) => s.trim())
        .flatMap((s) => [`button${s}`, `[role="button"]${s}`, `a[href]${s}`]).join(', '),
    )];
    const plain = [...document.querySelectorAll('button, [role="button"]')];
    const seen = new Set();
    const out = [];
    for (const el of [...preferred, ...plain]) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (insideAnyDialog(el) || !enabled(el) || !isVisible(el)) continue;
      out.push(el);
    }
    return out.slice(0, maxCandidates);
  })();

  const describe = (el, dialog) => {
    if (!el || el === document.body || el === document.documentElement) {
      return { selector: '(body)', text: '', insideDialog: false };
    }
    return { selector: selectorFor(el), text: textFor(el), insideDialog: !!dialog && dialog.contains(el) };
  };

  window.__kbProbe = {
    dialogs,
    candidates,
    focusables: [],
    isVisible,
    selectorFor,
    textFor,
    describe,
    dialogInfo() {
      const used = new Set();
      return dialogs.map((d, index) => {
        const container = containerFor(d);
        let reportSelector = selectorFor(container);
        if (used.has(reportSelector)) reportSelector = selectorFor(d);
        used.add(reportSelector);
        return {
          index,
          reportSelector,
          dialogSelector: selectorFor(d),
          role: d.getAttribute('role') || d.tagName.toLowerCase(),
          label: d.getAttribute('aria-label') || '',
          containerHtml: openingTag(container),
          visibleOnLoad: isVisible(d),
        };
      });
    },
    candidateInfo() {
      return candidates.map((el, index) => ({ index, selector: selectorFor(el), text: textFor(el) }));
    },
    visibleDialogs() {
      return dialogs.map((d, i) => (isVisible(d) ? i : -1)).filter((i) => i >= 0);
    },
    collectFocusables(dialogIndex) {
      const d = dialogs[dialogIndex];
      this.focusables = [...d.querySelectorAll(focusableSelector)]
        .filter((el) => enabled(el) && isVisible(el));
      return this.focusables.map((el) => ({ selector: selectorFor(el), text: textFor(el) }));
    },
    focusState(dialogIndex) {
      const d = dialogs[dialogIndex];
      const active = document.activeElement;
      return {
        ...describe(active, d),
        focusableIndex: this.focusables.indexOf(active),
        dialogVisible: isVisible(d),
      };
    },
  };
  return true;
}

// ---------------------------------------------------------------------------
// Browser driving
// ---------------------------------------------------------------------------
async function freshPage(browser, url, pageErrors) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(GOTO_TIMEOUT_MS);
  page.on('pageerror', (err) => pageErrors.push(String(err && err.message ? err.message : err)));
  try {
    const response = await page.goto(url, { waitUntil: 'load', timeout: GOTO_TIMEOUT_MS });
    if (response && !response.ok() && !url.startsWith('file://')) {
      throw new HarnessError(`loading ${url} returned HTTP ${response.status()}`);
    }
    await page.evaluate(installHelpers, {
      dialogSelector: DIALOG_SELECTOR,
      focusableSelector: FOCUSABLE_SELECTOR,
      preferredSelector: PREFERRED_OPENER_SELECTOR,
      maxCandidates: MAX_OPENER_CANDIDATES,
    });
  } catch (err) {
    await context.close().catch(() => {});
    if (err instanceof HarnessError) throw err;
    throw new HarnessError(`could not load ${url}: ${err.message}`);
  }
  return { page, close: () => context.close().catch(() => {}) };
}

async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => {
    const done = setTimeout(resolve, 100);
    requestAnimationFrame(() => setTimeout(() => { clearTimeout(done); resolve(); }, 0));
  }));
}

async function clickCandidate(page, index) {
  const handle = await page.evaluateHandle((i) => window.__kbProbe.candidates[i], index);
  const el = handle.asElement();
  if (!el) return false;
  try {
    await el.click({ timeout: CLICK_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  } finally {
    await handle.dispose().catch(() => {});
  }
}

async function waitForDialogVisible(page, dialogIndex, timeout) {
  try {
    await page.waitForFunction(
      (i) => window.__kbProbe.isVisible(window.__kbProbe.dialogs[i]), dialogIndex, { timeout, polling: 50 },
    );
    return true;
  } catch {
    return false;
  }
}

async function waitForDialogHidden(page, dialogIndex, timeout) {
  try {
    await page.waitForFunction(
      (i) => !window.__kbProbe.isVisible(window.__kbProbe.dialogs[i]), dialogIndex, { timeout, polling: 50 },
    );
    return true;
  } catch {
    return false;
  }
}

// Find the first candidate whose click makes each (initially hidden) dialog visible.
async function findOpeners(browser, url, dialogs, candidates, pageErrors, attempts) {
  const openers = new Map();
  const pending = new Set(dialogs.filter((d) => !d.visibleOnLoad).map((d) => d.index));
  for (const candidate of candidates) {
    if (pending.size === 0) break;
    const { page, close } = await freshPage(browser, url, pageErrors);
    let opened = [];
    let clicked = false;
    try {
      clicked = await clickCandidate(page, candidate.index);
      if (clicked) {
        // Give the first still-pending dialog a moment to animate in, then read all of them.
        await waitForDialogVisible(page, [...pending][0], OPEN_WAIT_MS);
        opened = await page.evaluate(() => window.__kbProbe.visibleDialogs()).catch(() => []);
      }
    } finally {
      await close();
    }
    attempts.push({ ...candidate, clicked, opened });
    for (const i of opened) {
      if (pending.has(i)) { openers.set(i, candidate); pending.delete(i); }
    }
  }
  return openers;
}

async function openDialog(browser, url, dialog, opener, pageErrors) {
  const fresh = await freshPage(browser, url, pageErrors);
  try {
    const info = await fresh.page.evaluate(() => window.__kbProbe.candidateInfo());
    if (opener) {
      const current = info[opener.index];
      if (!current || current.selector !== opener.selector) {
        throw new HarnessError(`opener ${opener.selector} not found at the same position on reload`);
      }
      if (!(await clickCandidate(fresh.page, opener.index))) {
        throw new HarnessError(`clicking opener ${opener.selector} failed on reload`);
      }
    }
    if (!(await waitForDialogVisible(fresh.page, dialog.index, OPEN_WAIT_MS))) {
      throw new HarnessError(`dialog ${dialog.reportSelector} did not open on reload`);
    }
    await settle(fresh.page);
    return fresh;
  } catch (err) {
    await fresh.close();
    throw err;
  }
}

async function tabSequence(browser, url, dialog, opener, key, pageErrors) {
  const { page, close } = await openDialog(browser, url, dialog, opener, pageErrors);
  try {
    const focusables = await page.evaluate((i) => window.__kbProbe.collectFocusables(i), dialog.index);
    const initial = await page.evaluate((i) => window.__kbProbe.focusState(i), dialog.index);
    const presses = 2 * focusables.length + 2;
    const steps = [];
    for (let n = 1; n <= presses; n += 1) {
      await page.keyboard.press(key);
      await settle(page);
      steps.push({ press: n, key, ...(await page.evaluate((i) => window.__kbProbe.focusState(i), dialog.index)) });
    }
    return { focusables, initial, steps };
  } finally {
    await close();
  }
}

async function escapeProbe(browser, url, dialog, opener, pageErrors) {
  const { page, close } = await openDialog(browser, url, dialog, opener, pageErrors);
  try {
    const focusables = await page.evaluate((i) => window.__kbProbe.collectFocusables(i), dialog.index);
    let before = await page.evaluate((i) => window.__kbProbe.focusState(i), dialog.index);
    let focusedFirstControl = false;
    // A keyboard user presses Escape from inside the dialog; put focus there if the page did not.
    if (!before.insideDialog && focusables.length > 0) {
      await page.evaluate(() => window.__kbProbe.focusables[0].focus());
      focusedFirstControl = true;
      before = await page.evaluate((i) => window.__kbProbe.focusState(i), dialog.index);
    }
    await page.keyboard.press('Escape');
    const closes = await waitForDialogHidden(page, dialog.index, CLOSE_WAIT_MS);
    const after = await page.evaluate((i) => window.__kbProbe.focusState(i), dialog.index);
    return { focusBeforeEscape: before, focusedFirstControl, closes, focusAfterEscape: after };
  } finally {
    await close();
  }
}

async function probe(url) {
  const pageErrors = [];
  const browser = await chromium.launch({ timeout: LAUNCH_TIMEOUT_MS }).catch((err) => {
    throw new HarnessError(`could not launch Chromium: ${err.message}`);
  });
  try {
    const first = await freshPage(browser, url, pageErrors);
    let dialogs;
    let candidates;
    try {
      dialogs = await first.page.evaluate(() => window.__kbProbe.dialogInfo());
      candidates = await first.page.evaluate(() => window.__kbProbe.candidateInfo());
    } finally {
      await first.close();
    }

    const attempts = [];
    const openers = await findOpeners(browser, url, dialogs, candidates, pageErrors, attempts);
    const probes = [];
    for (const dialog of dialogs) {
      const opener = openers.get(dialog.index) || null;
      if (!dialog.visibleOnLoad && !opener) {
        probes.push({ dialog, opener: null, status: 'not-probed', openerAttempts: attempts });
        throw Object.assign(
          new HarnessError(
            `no control opened dialog ${dialog.reportSelector} (tried ${attempts.length} candidate(s)); ` +
            'its keyboard behaviour was NOT probed',
          ),
          { probes },
        );
      }
      const tab = await tabSequence(browser, url, dialog, opener, 'Tab', pageErrors);
      const shiftTab = await tabSequence(browser, url, dialog, opener, 'Shift+Tab', pageErrors);
      const escape = await escapeProbe(browser, url, dialog, opener, pageErrors);

      const sameList = JSON.stringify(tab.focusables) === JSON.stringify(shiftTab.focusables);
      const reachedBy = (run) => new Set(run.steps.map((s) => s.focusableIndex).filter((i) => i >= 0));
      const tabReached = reachedBy(tab);
      const shiftReached = reachedBy(shiftTab);
      probes.push({
        dialog,
        opener: opener
          ? { selector: opener.selector, text: opener.text }
          : { selector: null, text: null, note: 'dialog visible on load' },
        status: 'probed',
        openerAttempts: attempts.filter((a) => !opener || a.index <= opener.index),
        focusables: tab.focusables,
        tab: { focusAfterOpen: tab.initial, presses: tab.steps },
        shiftTab: {
          focusAfterOpen: shiftTab.initial,
          presses: shiftTab.steps,
          sameFocusablesAsTabRun: sameList,
          unreached: sameList ? shiftTab.focusables.filter((_, i) => !shiftReached.has(i)) : null,
        },
        unreached: tab.focusables.filter((_, i) => !tabReached.has(i)),
        escape,
      });
    }
    return { probes, pageErrors };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const label = (f) => `${f.selector} ${f.text ? `'${f.text}'` : '(no text)'}`;
const where = (s) => (s.selector === '(body)' ? '(no element focused)' : s.insideDialog ? '(inside dialog)' : '(outside dialog)');
const closedNote = (s) => (s.dialogVisible === false ? ' [dialog no longer visible]' : '');

function buildViolations(probes) {
  const unreachableNodes = [];
  const trapNodes = [];
  const unreachableHelp = [];
  const trapHelp = [];
  for (const p of probes) {
    const d = p.dialog;
    const sequence = p.tab.presses.map((s) => label(s)).join(' -> ');
    const how = p.opener.selector ? `opened via ${p.opener.selector}` : 'open on load';
    if (p.unreached.length > 0) {
      const names = p.unreached.map(label).join(', ');
      unreachableHelp.push(
        `Tab never reaches ${names} in dialog ${d.reportSelector}; observed Tab focus sequence: ${sequence}`,
      );
      unreachableNodes.push({
        target: [d.reportSelector],
        html: d.containerHtml,
        failureSummary:
          'Fix all of the following:\n' +
          `  Dialog ${d.reportSelector} (${how}) has ${p.focusables.length} focusable control(s); ` +
          `${p.unreached.length} never receive focus from Tab: ${names}\n` +
          `  Observed Tab sequence (${p.tab.presses.length} presses): ${sequence}`,
      });
    }
    if (!p.escape.closes) {
      trapHelp.push(`Pressing Escape does not close dialog ${d.reportSelector}`);
      trapNodes.push({
        target: [d.reportSelector],
        html: d.containerHtml,
        failureSummary:
          'Fix all of the following:\n' +
          `  Dialog ${d.reportSelector} (${how}) stayed open after Escape with focus on ` +
          `${label(p.escape.focusBeforeEscape)}; keyboard users cannot dismiss it`,
      });
    }
  }
  const violations = [];
  if (trapNodes.length > 0) {
    violations.push({
      id: 'keyboard-trap',
      impact: 'critical',
      tags: ['wcag2a', 'wcag212'],
      description: 'Keyboard users must be able to leave a dialog; pressing Escape must close it',
      help: trapHelp.join('; '),
      helpUrl: TRAP_HELP_URL,
      nodes: trapNodes,
    });
  }
  if (unreachableNodes.length > 0) {
    violations.push({
      id: 'keyboard-unreachable',
      impact: 'serious',
      tags: ['wcag2a', 'wcag211'],
      description: 'All controls inside a dialog must be reachable with the keyboard',
      help: unreachableHelp.join('; '),
      helpUrl: UNREACHABLE_HELP_URL,
      nodes: unreachableNodes,
    });
  }
  return violations;
}

function printDialogTrace(p, number) {
  const d = p.dialog;
  const lines = [];
  lines.push(`Dialog ${number}: ${d.reportSelector} (role=${d.role} on ${d.dialogSelector}${d.label ? `, label '${d.label}'` : ''})`);
  if (p.status !== 'probed') {
    lines.push('  Opener: NONE FOUND - dialog not probed');
    for (const a of p.openerAttempts) lines.push(`    tried ${label(a)}: ${a.clicked ? 'clicked, dialog stayed hidden' : 'click failed'}`);
    console.log(lines.join('\n'));
    return;
  }
  lines.push(p.opener.selector
    ? `  Opener: ${label(p.opener)} (found after ${p.openerAttempts.length} candidate click(s))`
    : '  Opener: none needed (dialog visible on load)');
  lines.push(`  Focusable controls inside dialog (${p.focusables.length}):`);
  p.focusables.forEach((f, i) => lines.push(`    ${i + 1}. ${label(f)}`));
  for (const [name, run] of [['Tab', p.tab], ['Shift+Tab', p.shiftTab]]) {
    lines.push(`  ${name} probe (fresh load, open, ${run.presses.length} presses):`);
    lines.push(`    Focus after opening -> ${label(run.focusAfterOpen)} ${where(run.focusAfterOpen)}`);
    for (const s of run.presses) {
      lines.push(`    ${name} ${s.press} -> ${label(s)} ${where(s)}${closedNote(s)}`);
    }
  }
  lines.push(`  Unreached by Tab (${p.unreached.length}): ${p.unreached.length ? p.unreached.map(label).join(', ') : 'none'}`);
  if (p.shiftTab.unreached) {
    lines.push(`  Unreached by Shift+Tab (${p.shiftTab.unreached.length}): ${p.shiftTab.unreached.length ? p.shiftTab.unreached.map(label).join(', ') : 'none'}`);
  }
  const e = p.escape;
  lines.push(`  Escape probe (fresh load, open${e.focusedFirstControl ? ', focus moved to first control' : ''}): focus on ${label(e.focusBeforeEscape)}`);
  lines.push(`  Escape closes dialog: ${e.closes ? 'yes' : 'no'}`);
  console.log(lines.join('\n'));
}

function removeStaleReport(outPath) {
  // A harness error must never leave an older passing report behind for a consumer to read.
  try {
    fs.unlinkSync(outPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw new HarnessError(`cannot remove stale report ${outPath}: ${err.message}`);
  }
}

async function main() {
  const { target, out } = parseArgs(process.argv.slice(2));
  const url = resolveUrl(target);
  removeStaleReport(out);

  console.log(`\nKeyboard probe: ${url}`);
  let result;
  try {
    result = await probe(url);
  } catch (err) {
    if (err.probes) err.probes.forEach((p, i) => printDialogTrace(p, i + 1));
    throw err;
  }
  const { probes, pageErrors } = result;

  console.log(`Dialogs found: ${probes.length}\n`);
  probes.forEach((p, i) => { printDialogTrace(p, i + 1); console.log(''); });
  if (pageErrors.length > 0) {
    console.log(`Page script errors during probing (${pageErrors.length}):`);
    for (const msg of [...new Set(pageErrors)]) console.log(`  ${msg}`);
    console.log('');
  }

  const violations = buildViolations(probes);
  const report = {
    testEngine: { name: 'guardrail-keyboard-probe', version: '1' },
    url,
    timestamp: new Date().toISOString(),
    dialogsFound: probes.length,
    violations,
    probes,
    pageErrors,
  };

  console.log(`${violations.length} violation type(s) found`);
  if (probes.length === 0) console.log('No dialogs ([role="dialog"], dialog, [aria-modal="true"]) on this page.');
  for (const v of violations) {
    console.log(`[${v.impact.toUpperCase()}] ${v.id} (${v.tags.join(', ')}) - ${v.description}`);
    console.log(`  More info: ${v.helpUrl}`);
    for (const node of v.nodes) {
      console.log(`  - ${node.target.join(' ')}`);
      console.log(`    ${node.failureSummary.replace(/\n/g, '\n    ')}`);
    }
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\nFull report written to ${out}`);

  process.exitCode = violations.length > 0 ? 1 : 0;
}

const watchdog = setTimeout(() => {
  console.error(`keyboard-scan: harness error: timed out after ${WATCHDOG_MS / 1000}s`);
  process.exit(2);
}, WATCHDOG_MS);
watchdog.unref();

main().catch((err) => {
  const msg = err instanceof HarnessError ? err.message : (err && err.stack) || String(err);
  console.error(`keyboard-scan: harness error: ${msg}`);
  process.exitCode = 2;
});
