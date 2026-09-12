#!/usr/bin/env node
// Functional integrity check for the demo app: confirms behaviour still works
// after (or independently of) any accessibility remediation.
//
// This is a behaviour check, not an accessibility check - Path 1 covers a11y.
// It exists so a patch that silences a violation by breaking the UI (removing a
// control, unwiring a handler) cannot pass unnoticed.
//
// The dialog keyboard section drives the shop-hours modal with real key presses
// (Tab x6, Shift+Tab x6, Escape) and records where focus lands. Those checks are
// required only with --require-dialog-keyboard (the gate for a keyboard-unreachable
// patch); without the flag they still run and print as [INFO pass]/[INFO fail] so a
// button-name patch is not failed for the modal bug it did not touch.
//
// Usage: node integrity-check/check.js [pathOrUrl] [--require-dialog-keyboard]
// Exit 0 = every required check passed, 1 = a required check failed, 2 = the harness itself broke.

const path = require('path');
const { chromium } = require('playwright');

const DEFAULT_TARGET = path.join(__dirname, '..', 'demo', 'index.html');
const USAGE = 'usage: node integrity-check/check.js [pathOrUrl] [--require-dialog-keyboard]';

// Every browser step has a bound so an unresponsive page fails, never hangs.
const LAUNCH_TIMEOUT_MS = 30000;
const NAV_TIMEOUT_MS = 15000;
const ACTION_TIMEOUT_MS = 5000;
const WATCHDOG_MS = 120000;
const DIALOG_TAB_PRESSES = 6;

function toUrl(target) {
  return /^https?:\/\//.test(target) ? target : 'file://' + path.resolve(target);
}

function parseArgs(argv) {
  let target = null;
  let requireDialogKeyboard = false;
  for (const arg of argv) {
    if (arg === '--require-dialog-keyboard') requireDialogKeyboard = true;
    else if (arg === '-h' || arg === '--help') return { help: true };
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else if (target === null) target = arg;
    else throw new Error(`unexpected extra argument ${arg}`);
  }
  return { target: target || DEFAULT_TARGET, requireDialogKeyboard };
}

const checks = [];
function record(name, passed, detail, required = true) {
  checks.push({ name, passed: Boolean(passed), detail, required });
  const tag = required ? (passed ? 'PASS' : 'FAIL') : `INFO ${passed ? 'pass' : 'fail'}`;
  console.log(`  [${tag}] ${name}${detail ? ` - ${detail}` : ''}`);
}

// Where focus is right now, relative to the shop-hours modal.
function describeFocus(page) {
  return page.evaluate(() => {
    const modal = document.querySelector('#hours-modal');
    const el = document.activeElement;
    const modalVisible = Boolean(modal && !modal.hidden && modal.checkVisibility());
    if (!el || el === document.body || el === document.documentElement) {
      return { label: '<body>', inModal: false, isGetDirections: false, modalVisible };
    }
    const text = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    const classes = [...el.classList].map((c) => '.' + c).join('');
    const inModal = Boolean(modal && modal.contains(el));
    return {
      label: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${classes}${text ? ` "${text}"` : ''}`,
      inModal,
      isGetDirections: inModal && el.matches('a.button-dark') && /get directions/i.test(text),
      modalVisible,
    };
  });
}

function formatSequence(steps) {
  return steps.map((s) => `${s.key}: ${s.label}${s.inModal ? '' : ' (OUTSIDE modal)'}`).join('\n      ');
}

async function checkDialogKeyboard(page, modal, required) {
  console.log(`\n  Dialog keyboard (${required ? 'required' : 'informational'}):`);
  const names = {
    reach: 'Tab reaches Get directions inside the modal',
    tabContain: 'focus stays inside the modal while tabbing',
    shiftContain: 'Shift+Tab keeps focus inside the modal',
    escape: 'Escape closes the modal after keyboard navigation',
  };

  const tabSteps = [];
  const shiftSteps = [];
  try {
    if (!(await modal.isHidden())) throw new Error('modal was already open before the dialog section');
    await page.locator('.text-button').click();
    await modal.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
    const opened = await describeFocus(page);
    console.log(`    focus after opening: ${opened.label}${opened.inModal ? '' : ' (OUTSIDE modal)'}`);

    for (let i = 1; i <= DIALOG_TAB_PRESSES; i += 1) {
      await page.keyboard.press('Tab');
      tabSteps.push({ key: `Tab ${i}`, ...(await describeFocus(page)) });
    }
    console.log(`    Tab sequence:\n      ${formatSequence(tabSteps)}`);

    for (let i = 1; i <= DIALOG_TAB_PRESSES; i += 1) {
      await page.keyboard.press('Shift+Tab');
      shiftSteps.push({ key: `Shift+Tab ${i}`, ...(await describeFocus(page)) });
    }
    console.log(`    Shift+Tab sequence:\n      ${formatSequence(shiftSteps)}`);
  } catch (err) {
    // The interaction itself failed (missing opener, modal never opened): every
    // dialog claim is unproven, so each one is recorded as failed.
    const detail = `interaction failed: ${err.message.split('\n')[0]}`;
    for (const name of Object.values(names)) record(name, false, detail, required);
    return;
  }

  const reached = tabSteps.find((s) => s.isGetDirections);
  record(names.reach, Boolean(reached),
    reached ? `on ${reached.key}` : `not focused in ${DIALOG_TAB_PRESSES} Tab presses`, required);

  const tabEscape = tabSteps.find((s) => !s.inModal || !s.modalVisible);
  record(names.tabContain, !tabEscape,
    tabEscape ? `${tabEscape.key} moved focus to ${tabEscape.label}${tabEscape.modalVisible ? '' : ' (modal closed)'}` : '',
    required);

  const shiftEscape = shiftSteps.find((s) => !s.inModal || !s.modalVisible);
  record(names.shiftContain, !shiftEscape,
    shiftEscape ? `${shiftEscape.key} moved focus to ${shiftEscape.label}${shiftEscape.modalVisible ? '' : ' (modal closed)'}` : '',
    required);

  const openBeforeEscape = await modal.isVisible();
  await page.keyboard.press('Escape');
  const closedAfterEscape = await modal.isHidden();
  record(names.escape, openBeforeEscape && closedAfterEscape,
    openBeforeEscape ? (closedAfterEscape ? '' : 'modal still open after Escape') : 'modal was not open before Escape',
    required);
}

async function run({ target, requireDialogKeyboard }) {
  const url = toUrl(target);
  console.log(`\nIntegrity check: ${url}${requireDialogKeyboard ? ' (dialog keyboard checks required)' : ''}\n`);

  const browser = await chromium.launch({ timeout: LAUNCH_TIMEOUT_MS });
  const page = await browser.newPage();
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  try {
    await page.goto(url);
    try {
      await runChecks(page, pageErrors, requireDialogKeyboard);
    } catch (err) {
      // The page loaded, so a control that cannot be found or clicked is a broken
      // app (exit 1), not a broken harness (exit 2).
      record('every interaction completed (no missing or unclickable control)', false,
        err.message.split('\n')[0]);
    }
  } finally {
    await browser.close();
  }
  return summarize();
}

async function runChecks(page, pageErrors, requireDialogKeyboard) {
  {
    // 1. The page and its script actually loaded.
    record('page loads with the expected title', (await page.title()).includes('Harbor'));
    record('no uncaught page errors on load', pageErrors.length === 0, pageErrors.join('; '));

    // 2. Structure the demo is expected to show.
    record('header bag button present', (await page.locator('.bag-button').count()) === 1);
    record('three product cards render', (await page.locator('.product-card').count()) === 3);
    record('primary navigation has three links',
      (await page.locator('nav[aria-label="Primary navigation"] a').count()) === 3);

    // 3. The modal still opens and closes from both triggers.
    const modal = page.locator('#hours-modal');
    record('modal starts hidden', await modal.isHidden());

    // Confirm the click really landed on the bag button (a trusted click event
    // reached it) and that it took the modal from hidden to visible.
    await page.evaluate(() => {
      window.__bagClicks = 0;
      document.addEventListener('click', (e) => {
        if (e.isTrusted && e.target instanceof Element && e.target.closest('.bag-button')) window.__bagClicks += 1;
      }, true);
    });
    const hiddenBeforeBagClick = await modal.isHidden();
    await page.locator('.bag-button').click();
    const bagClicks = await page.evaluate(() => window.__bagClicks);
    const visibleAfterBagClick = await modal.isVisible();
    record('bag button opens the modal', hiddenBeforeBagClick && bagClicks === 1 && visibleAfterBagClick,
      `click reached button: ${bagClicks === 1 ? 'yes' : `no (${bagClicks} clicks)`}, `
      + `modal ${hiddenBeforeBagClick ? 'hidden' : 'VISIBLE'} -> ${visibleAfterBagClick ? 'visible' : 'HIDDEN'}`);

    await page.locator('.modal-close').click();
    record('close button dismisses the modal', await modal.isHidden());

    await page.locator('.text-button').click();
    record('"View shop hours" opens the modal', await modal.isVisible());

    // 4. The modal's keyboard contract.
    await page.keyboard.press('Escape');
    record('Escape dismisses the modal', await modal.isHidden());

    // 5. The gift form still submits and reports back.
    await page.fill('#customer-name', 'Integrity Check');
    await page.fill('#customer-email', 'integrity@example.com');
    await page.selectOption('#occasion', { label: 'Birthday' });
    await page.click('#gift-form button[type="submit"]');
    const status = (await page.locator('#form-status').textContent()) || '';
    record('form submit sets the status message', status.trim().length > 0, status.trim());
    record('form resets after submit', (await page.inputValue('#customer-name')) === '');

    // 6. The dialog is operable from the keyboard alone (WCAG 2.1.1 / 2.1.2).
    await checkDialogKeyboard(page, modal, requireDialogKeyboard);
    console.log('');

    record('no uncaught page errors during interaction', pageErrors.length === 0, pageErrors.join('; '));
  }
}

function summarize() {
  const required = checks.filter((c) => c.required);
  const failed = required.filter((c) => !c.passed);
  const info = checks.filter((c) => !c.required);
  console.log(`\n${required.length - failed.length}/${required.length} required checks passed`);
  if (info.length) {
    const infoFailed = info.filter((c) => !c.passed);
    console.log(`${info.length - infoFailed.length}/${info.length} informational checks passed`
      + (infoFailed.length ? ` (not gating; failing: ${infoFailed.map((c) => c.name).join(', ')})` : ''));
  }
  if (required.length === 0) {
    console.log('FAILED: no required checks ran');
    return 1;
  }
  if (failed.length) {
    console.log('FAILED: ' + failed.map((c) => c.name).join(', '));
    return 1;
  }
  console.log('INTEGRITY CHECK PASSED: demo app behaviour is intact');
  return 0;
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`${err.message}\n${USAGE}`);
  process.exit(2);
}
if (options.help) {
  console.log(USAGE);
  process.exit(0);
}

const watchdog = setTimeout(() => {
  console.error(`harness error: integrity check did not finish within ${WATCHDOG_MS / 1000}s`);
  process.exit(2);
}, WATCHDOG_MS);
watchdog.unref();

run(options)
  .then((code) => { process.exitCode = code; })
  .catch((err) => { console.error('harness error:', err); process.exitCode = 2; });
