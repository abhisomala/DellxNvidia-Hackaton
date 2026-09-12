#!/usr/bin/env node
/**
 * Emits RAW axe-core results (`axe.run()` output, unmodified) for a page. This is the shape an axe-core-only
 * scanner produces; the remediation harness accepts it directly.
 *   node scanner/axe-raw.mjs --url http://127.0.0.1:5174/ [--tags wcag2a,wcag2aa,wcag21a,wcag21aa,wcag22aa]
 */
import { createRequire } from 'node:module';
import { launchBrowser } from './browser.mjs';
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i > -1 ? args[i + 1] : d; };
const url = opt('--url', 'http://127.0.0.1:5174/');
const tags = opt('--tags', 'wcag2a,wcag2aa,wcag21a,wcag21aa,wcag22aa').split(',');
const browser = await launchBrowser();
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'networkidle' });
await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
const results = await page.evaluate(async (t) => await window.axe.run(document, { runOnly: { type: 'tag', values: t } }), tags);
await browser.close();
process.stdout.write(JSON.stringify(results, null, 2) + '\n');
