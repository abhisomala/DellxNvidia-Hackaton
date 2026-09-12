#!/usr/bin/env node
// Basic WCAG violation scanner: loads a page with Playwright and audits it with axe-core.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const DEFAULT_TARGET = path.join(__dirname, '..', 'demo', 'index.html');
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

function toFileUrl(filePath) {
  return 'file://' + path.resolve(filePath);
}

async function scan(target) {
  const url = /^https?:\/\//.test(target) ? target : toFileUrl(target);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url);
    await page.addScriptTag({ content: axeSource });
    const results = await page.evaluate(
      (tags) => window.axe.run(document, { runOnly: { type: 'tag', values: tags } }),
      WCAG_TAGS,
    );
    return results;
  } finally {
    await browser.close();
  }
}

function printReport(results) {
  const { violations, url } = results;

  console.log(`\nWCAG scan: ${url}`);
  console.log(`${violations.length} violation type(s) found\n`);

  if (violations.length === 0) {
    console.log('No violations detected for tags: ' + WCAG_TAGS.join(', '));
    return;
  }

  const impactOrder = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  const sorted = [...violations].sort(
    (a, b) => (impactOrder[a.impact] ?? 4) - (impactOrder[b.impact] ?? 4),
  );

  for (const v of sorted) {
    console.log(`[${(v.impact || 'unknown').toUpperCase()}] ${v.id} — ${v.help}`);
    console.log(`  WCAG: ${v.tags.filter((t) => t.startsWith('wcag')).join(', ') || 'n/a'}`);
    console.log(`  More info: ${v.helpUrl}`);
    for (const node of v.nodes) {
      console.log(`  - ${node.target.join(' ')}`);
      console.log(`    ${node.failureSummary.replace(/\n/g, '\n    ')}`);
    }
    console.log('');
  }
}

async function main() {
  const target = process.argv[2] || DEFAULT_TARGET;
  const results = await scan(target);
  printReport(results);

  const outDir = path.join(__dirname, '..', 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'a11y-report.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`Full report written to ${path.relative(process.cwd(), outPath)}`);

  if (results.violations.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 2;
});
