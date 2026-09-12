#!/usr/bin/env node
// Pre-filming proof for the demo: the manual keyboard/screen-reader test, automated
// with evidence (screenshots, a Playwright trace and proof.json).
//
// Claims (every one must pass for exit 0):
//   1. The header bag button has a non-empty accessible name in Chrome's real
//      accessibility tree (read over CDP, not inferred from the DOM).
//   2. After opening the modal from the bag button, Tab reaches "Get directions".
//   3. Escape closes the modal.
// Precondition (also gating): Tab from the top of the page focuses the bag button,
// which is what screenshot 01 shows.
//
// Usage: node scripts/demo-proof.js [pathOrUrl] [--out <dir>]   (default out: reports/demo-proof/)
// Exit 0 = every claim passed, 1 = a claim failed, 2 = the harness itself broke.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_TARGET = path.join(REPO_ROOT, 'demo', 'index.html');
const DEFAULT_OUT = path.join(REPO_ROOT, 'reports', 'demo-proof');
const USAGE = 'usage: node scripts/demo-proof.js [pathOrUrl] [--out <dir>]';

const LAUNCH_TIMEOUT_MS = 30000;
const NAV_TIMEOUT_MS = 15000;
const ACTION_TIMEOUT_MS = 5000;
const CDP_TIMEOUT_MS = 10000;
const WATCHDOG_MS = 120000;
const MAX_TABS_TO_BAG = 12;
const MAX_TABS_IN_MODAL = 6;

// Every file this script writes; removed up front so a stale artifact from an
// earlier run can never pass for evidence of this one.
const ARTIFACT_NAMES = [
  '01-bag-button-focused.png', '01-bag-button-NOT-focused.png',
  '02-get-directions-focused.png', '02-get-directions-NOT-focused.png',
  '03-after-escape.png', 'trace.zip', 'proof.json',
];

function toUrl(target) {
  return /^https?:\/\//.test(target) ? target : 'file://' + path.resolve(target);
}

function parseArgs(argv) {
  let target = null;
  let out = DEFAULT_OUT;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return { help: true };
    if (arg === '--out') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('--out needs a directory');
      out = argv[i += 1];
    } else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else if (target === null) target = arg;
    else throw new Error(`unexpected extra argument ${arg}`);
  }
  return { target: target || DEFAULT_TARGET, out: path.resolve(out) };
}

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function firstLine(err) {
  return String((err && err.message) || err).split('\n')[0];
}

function describeFocus(page) {
  return page.evaluate(() => {
    const modal = document.querySelector('#hours-modal');
    const el = document.activeElement;
    const modalVisible = Boolean(modal && !modal.hidden && modal.checkVisibility());
    if (!el || el === document.body || el === document.documentElement) {
      return { label: '<body>', inModal: false, isBagButton: false, isGetDirections: false, modalVisible };
    }
    const text = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    const classes = [...el.classList].map((c) => '.' + c).join('');
    const inModal = Boolean(modal && modal.contains(el));
    return {
      label: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${classes}${text ? ` "${text}"` : ''}`,
      inModal,
      isBagButton: el.matches('header .bag-button'),
      isGetDirections: inModal && el.matches('a.button-dark') && /get directions/i.test(text),
      modalVisible,
    };
  });
}

// The bag button's node as Chrome's accessibility tree computes it.
async function readBagButtonAXNode(context, page) {
  const cdp = await withTimeout(context.newCDPSession(page), CDP_TIMEOUT_MS, 'CDP session');
  try {
    const send = (method, params) => withTimeout(cdp.send(method, params), CDP_TIMEOUT_MS, method);
    const { root } = await send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '.bag-button' });
    if (!nodeId) return { found: false };
    const { nodes } = await send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
    const node = nodes && nodes[0];
    if (!node) return { found: true, axNode: null };
    const name = node.name || {};
    // Chrome marks the sources below the winning one as superseded; the winner is
    // the first source that produced a value and was not superseded.
    const used = (name.sources || []).find((s) => s.value && !s.superseded);
    return {
      found: true,
      ignored: Boolean(node.ignored),
      role: node.role ? node.role.value : null,
      name: typeof name.value === 'string' ? name.value : '',
      nameSource: used ? [used.attribute || used.nativeSource, used.type].filter(Boolean).join(' / ') : null,
      axNode: node,
    };
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function run({ target, out }) {
  const url = toUrl(target);
  fs.mkdirSync(out, { recursive: true });
  for (const name of ARTIFACT_NAMES) fs.rmSync(path.join(out, name), { force: true });

  console.log(`\nDemo proof: ${url}\nEvidence dir: ${out}\n`);
  const proof = {
    tool: 'guardrail-demo-proof', version: '1', url, timestamp: new Date().toISOString(),
    browser: null, accessibility: null, keyboardToBagButton: null, dialog: null, escape: null,
    claims: [], screenshots: [], trace: null, pageErrors: [], passed: false,
  };
  const claim = (id, text, passed, detail) => {
    proof.claims.push({ id, claim: text, passed: Boolean(passed), detail });
    console.log(`[${passed ? 'PASS' : 'FAIL'}] ${text}${detail ? ` - ${detail}` : ''}`);
  };
  const shoot = async (fn, name) => {
    const file = path.join(out, name);
    try {
      await fn(file);
      proof.screenshots.push(name);
      console.log(`      screenshot: ${file}`);
    } catch (err) {
      console.log(`      screenshot ${name} FAILED: ${firstLine(err)}`);
    }
  };

  const browser = await chromium.launch({ timeout: LAUNCH_TIMEOUT_MS });
  let tracing = false;
  try {
    proof.browser = `chromium ${browser.version()}`;
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.tracing.start({ screenshots: true, snapshots: true, title: 'GuardRail demo proof' });
    tracing = true;
    const page = await context.newPage();
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    page.on('pageerror', (err) => proof.pageErrors.push(err.message));
    await page.goto(url);

    // a) Accessibility: the real computed role/name from Chrome.
    let ax;
    try {
      ax = await readBagButtonAXNode(context, page);
    } catch (err) {
      ax = { found: null, error: firstLine(err) };
    }
    try {
      ax.headerAriaSnapshot = await page.locator('header').ariaSnapshot({ timeout: ACTION_TIMEOUT_MS });
    } catch (err) {
      ax.headerAriaSnapshot = null;
      ax.ariaSnapshotError = firstLine(err);
    }
    proof.accessibility = ax;
    console.log('a) Chrome accessibility tree, header .bag-button:');
    if (ax.error) console.log(`   CDP read failed: ${ax.error}`);
    else if (!ax.found) console.log('   no .bag-button element in the DOM');
    else console.log(`   role=${JSON.stringify(ax.role)} name=${JSON.stringify(ax.name)} `
      + `nameSource=${ax.nameSource || '(none)'} ignored=${ax.ignored}`);
    console.log(`   header ariaSnapshot:\n${(ax.headerAriaSnapshot || `(unavailable: ${ax.ariaSnapshotError})`)
      .split('\n').map((l) => '     ' + l).join('\n')}`);
    const namePassed = Boolean(ax.found && ax.axNode && !ax.ignored && ax.role === 'button' && ax.name.trim());
    claim('accessible-name', 'bag button has a non-empty accessible name in Chrome\'s accessibility tree', namePassed,
      ax.error ? `CDP read failed: ${ax.error}`
        : !ax.found ? 'bag button not found'
          : `role=${ax.role} name=${JSON.stringify(ax.name)}${ax.nameSource ? ` (from ${ax.nameSource})` : ''}${ax.ignored ? ' IGNORED' : ''}`);

    // b) Keyboard from the top of the page to the bag button.
    console.log('\nb) Tab from the top of the page to the bag button:');
    const toBag = [];
    let bagFocused = false;
    try {
      for (let i = 1; i <= MAX_TABS_TO_BAG && !bagFocused; i += 1) {
        await page.keyboard.press('Tab');
        const f = await describeFocus(page);
        toBag.push({ key: `Tab ${i}`, ...f });
        console.log(`   Tab ${i}: ${f.label}`);
        bagFocused = f.isBagButton;
      }
    } catch (err) {
      toBag.push({ error: firstLine(err) });
      console.log(`   keyboard step failed: ${firstLine(err)}`);
    }
    proof.keyboardToBagButton = { focused: bagFocused, steps: toBag };
    await shoot((file) => page.locator('header').screenshot({ path: file }),
      bagFocused ? '01-bag-button-focused.png' : '01-bag-button-NOT-focused.png');
    claim('bag-button-keyboard-focus', '(precondition) Tab from the page top focuses the bag button', bagFocused,
      bagFocused ? `after ${toBag.length} Tab press(es)` : `not focused in ${MAX_TABS_TO_BAG} Tab presses`);

    // c) Open the modal from the bag button, then Tab to "Get directions".
    console.log('\nc) Click the bag button, then Tab inside the modal:');
    const modal = page.locator('#hours-modal');
    const dialog = { opened: false, focusAfterOpen: null, steps: [], reached: false };
    try {
      await page.locator('.bag-button').click();
      dialog.opened = await modal.isVisible();
      dialog.focusAfterOpen = await describeFocus(page);
      console.log(`   modal ${dialog.opened ? 'opened' : 'DID NOT open'}; focus: ${dialog.focusAfterOpen.label}`);
      for (let i = 1; i <= MAX_TABS_IN_MODAL && dialog.opened && !dialog.reached; i += 1) {
        await page.keyboard.press('Tab');
        const f = await describeFocus(page);
        dialog.steps.push({ key: `Tab ${i}`, ...f });
        console.log(`   Tab ${i}: ${f.label}${f.inModal ? '' : ' (OUTSIDE modal)'}${f.modalVisible ? '' : ' (modal closed)'}`);
        dialog.reached = f.isGetDirections && f.modalVisible;
      }
    } catch (err) {
      dialog.error = firstLine(err);
      console.log(`   interaction failed: ${dialog.error}`);
    }
    proof.dialog = dialog;
    await shoot((file) => page.screenshot({ path: file }),
      dialog.reached ? '02-get-directions-focused.png' : '02-get-directions-NOT-focused.png');
    claim('tab-reaches-get-directions', 'Tab reaches "Get directions" inside the modal', dialog.reached,
      dialog.error ? `interaction failed: ${dialog.error}`
        : !dialog.opened ? 'bag button did not open the modal'
          : dialog.reached ? `on Tab ${dialog.steps.length}`
            : `not focused in ${MAX_TABS_IN_MODAL} Tab presses (focus visited: ${[...new Set(dialog.steps.map((s) => s.label))].join(', ')})`);

    // d) Escape closes the modal.
    console.log('\nd) Press Escape:');
    const escape = { openBefore: false, hiddenAfter: false, hiddenAttribute: null, focusAfter: null };
    try {
      escape.openBefore = await modal.isVisible();
      await page.keyboard.press('Escape');
      escape.hiddenAfter = await modal.isHidden();
      escape.hiddenAttribute = await modal.evaluate((el) => el.hidden);
      escape.focusAfter = await describeFocus(page);
      console.log(`   modal before: ${escape.openBefore ? 'open' : 'NOT open'}; after: ${escape.hiddenAfter ? 'hidden' : 'STILL VISIBLE'} `
        + `(hidden attribute ${escape.hiddenAttribute}); focus: ${escape.focusAfter.label}`);
    } catch (err) {
      escape.error = firstLine(err);
      console.log(`   interaction failed: ${escape.error}`);
    }
    proof.escape = escape;
    await shoot((file) => page.screenshot({ path: file }), '03-after-escape.png');
    const escapePassed = escape.openBefore && escape.hiddenAfter && escape.hiddenAttribute === true;
    claim('escape-closes-modal', 'Escape closes the modal', escapePassed,
      escape.error ? `interaction failed: ${escape.error}`
        : !escape.openBefore ? 'modal was not open before Escape'
          : escape.hiddenAfter ? '#hours-modal hidden' : 'modal still visible');
  } finally {
    if (tracing) {
      try {
        const context = browser.contexts()[0];
        await withTimeout(context.tracing.stop({ path: path.join(out, 'trace.zip') }), CDP_TIMEOUT_MS, 'trace save');
        proof.trace = 'trace.zip';
      } catch (err) {
        console.log(`trace save FAILED: ${firstLine(err)}`);
      }
    }
    await browser.close();
  }

  if (proof.pageErrors.length) console.log(`\npage errors: ${proof.pageErrors.join('; ')}`);
  const failed = proof.claims.filter((c) => !c.passed);
  proof.passed = proof.claims.length > 0 && failed.length === 0;
  fs.writeFileSync(path.join(out, 'proof.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(`\nEvidence: ${proof.screenshots.join(', ') || '(no screenshots)'}, ${proof.trace || '(no trace)'}, proof.json in ${out}`);
  console.log(proof.passed
    ? `DEMO PROOF PASSED: ${proof.claims.length}/${proof.claims.length} claims`
    : `DEMO PROOF FAILED: ${failed.map((c) => c.id).join(', ')}`);
  return proof.passed ? 0 : 1;
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
  console.error(`harness error: demo proof did not finish within ${WATCHDOG_MS / 1000}s`);
  process.exit(2);
}, WATCHDOG_MS);
watchdog.unref();

run(options)
  .then((code) => { process.exitCode = code; })
  .catch((err) => { console.error('harness error:', err); process.exitCode = 2; });
