#!/usr/bin/env node
/**
 * Functional check for the stand-in demo app (Path 1 would ship an equivalent for their app).
 * Exit 0 when every behavior still works, 1 otherwise. Prints a JSON summary on stdout.
 *
 *   node scanner/functional.mjs --url http://127.0.0.1:5174/
 *
 * Checks (they must pass BEFORE and AFTER remediation):
 *   upload:  activating #upload-submit shows "Assignment uploaded" in #upload-status
 *   enroll:  typing an email into #student-email and submitting #enroll-form shows "Enrolled: <email>"
 *   settings: activating #open-settings opens #settings-dialog; submitting shows "Settings saved"
 */
import { launchBrowser } from './browser.mjs';

const url = (() => { const i = process.argv.indexOf('--url'); return i > -1 ? process.argv[i + 1] : 'http://127.0.0.1:5174/'; })();

const checks = [
  {
    name: 'upload button click still works',
    run: async (page) => {
      await page.locator('#upload-submit').click();
      await page.locator('#upload-status').filter({ hasText: 'Assignment uploaded' }).waitFor({ timeout: 2000 });
    },
  },
  {
    name: 'enroll form still submits',
    run: async (page) => {
      await page.locator('#student-email').fill('netid@cornell.edu');
      await page.locator('#enroll-form button[type="submit"], #enroll-submit').first().click();
      await page.locator('#enroll-status').filter({ hasText: 'Enrolled: netid@cornell.edu' }).waitFor({ timeout: 2000 });
    },
  },
  {
    name: 'settings dialog opens and saves',
    run: async (page) => {
      await page.locator('#open-settings').click();
      await page.locator('#settings-dialog').waitFor({ state: 'visible', timeout: 2000 });
      await page.locator('#settings-save').click();
      await page.locator('#settings-saved-msg').filter({ hasText: 'Settings saved' }).waitFor({ timeout: 2000 });
    },
  },
];

const browser = await launchBrowser();
const results = [];
for (const c of checks) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    await c.run(page);
    if (errors.length) throw new Error('page errors: ' + errors.join(' | '));
    results.push({ name: c.name, passed: true });
  } catch (e) {
    results.push({ name: c.name, passed: false, error: String(e.message || e).split('\n').filter((l) => l.trim()).slice(0, 3).join(' ') });
  } finally {
    await page.close();
  }
}
await browser.close();
const passed = results.every((r) => r.passed);
console.log(JSON.stringify({ passed, results }, null, 2));
process.exit(passed ? 0 : 1);
