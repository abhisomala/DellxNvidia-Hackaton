#!/usr/bin/env node
// Functional integrity check for the demo app: confirms behaviour still works
// after (or independently of) any accessibility remediation.
//
// This is a behaviour check, not an accessibility check - Path 1 covers a11y.
// It exists so a patch that silences a violation by breaking the UI (removing a
// control, unwiring a handler) cannot pass unnoticed.
//
// Usage: node integrity-check/check.js [pathOrUrl]
// Exit 0 = every check passed, 1 = a check failed, 2 = the harness itself broke.

const path = require('path');
const { chromium } = require('playwright');

const DEFAULT_TARGET = path.join(__dirname, '..', 'demo', 'index.html');

function toUrl(target) {
  return /^https?:\/\//.test(target) ? target : 'file://' + path.resolve(target);
}

const checks = [];
function record(name, passed, detail) {
  checks.push({ name, passed, detail });
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` - ${detail}` : ''}`);
}

async function run(target) {
  const url = toUrl(target);
  console.log(`\nIntegrity check: ${url}\n`);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  try {
    await page.goto(url);

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

    await page.locator('.bag-button').click();
    record('bag button opens the modal', await modal.isVisible());

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

    record('no uncaught page errors during interaction', pageErrors.length === 0, pageErrors.join('; '));
  } finally {
    await browser.close();
  }

  const failed = checks.filter((c) => !c.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) {
    console.log('FAILED: ' + failed.map((c) => c.name).join(', '));
    return 1;
  }
  console.log('INTEGRITY CHECK PASSED: demo app behaviour is intact');
  return 0;
}

run(process.argv[2] || DEFAULT_TARGET)
  .then((code) => { process.exitCode = code; })
  .catch((err) => { console.error('harness error:', err); process.exitCode = 2; });
