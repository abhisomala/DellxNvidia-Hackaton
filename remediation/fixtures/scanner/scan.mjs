#!/usr/bin/env node
/**
 * Stand-in for Path 1's scanner. Emits the agreed violations JSON (schema_version 1.0).
 *
 *   node scanner/scan.mjs --url http://127.0.0.1:5174/ [--app-root demo-app] [--routes /,/other] [--out scan.json]
 *
 * Two sources of violations:
 *   1. axe-core (WCAG 2.x A/AA tags) run in a headless Chromium via Playwright  -> source_tool: "axe"
 *   2. a custom keyboard-trap probe: click each visible button; if a dialog appears,
 *      check that Escape closes it or Tab can leave it, or a close/cancel control exists -> source_tool: "custom", rule_id: "keyboard-trap"
 */
import { launchBrowser } from './browser.mjs';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');
const AXE_VERSION = require('axe-core/package.json').version;
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

function parseArgs(argv) {
  const args = { url: 'http://127.0.0.1:5174/', routes: ['/'], appRoot: '', out: '', trapTabs: 15 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--url') args.url = next();
    else if (a === '--routes') args.routes = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--app-root') args.appRoot = resolve(next());
    else if (a === '--out') args.out = next();
    else if (a === '--trap-tabs') args.trapTabs = Number(next());
    else if (a === '-h' || a === '--help') { console.log(readFileSync(new URL(import.meta.url)).toString().split('*/')[0]); process.exit(0); }
  }
  return args;
}

function uniqueSelectorFn(el) {
  if (!el) return null;
  if (el.id) return '#' + CSS.escape(el.id);
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.body) {
    let sel = node.tagName.toLowerCase();
    if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
    const sibs = Array.from(node.parentNode ? node.parentNode.children : []).filter((s) => s.tagName === node.tagName);
    if (sibs.length > 1) sel += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
    parts.unshift(sel);
    node = node.parentNode;
  }
  return parts.join(' > ');
}

async function runAxe(page, route) {
  await page.addScriptTag({ path: AXE_PATH });
  const results = await page.evaluate(async (tags) => {
    return await window.axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
  }, AXE_TAGS);
  const out = [];
  for (const v of results.violations) {
    v.nodes.forEach((node, i) => {
      out.push({
        id: `${v.id}#${i}`,
        rule_id: v.id,
        source_tool: 'axe',
        impact: v.impact || node.impact || 'unknown',
        wcag: v.tags.filter((t) => /^wcag/.test(t)),
        description: v.help || v.description,
        help: (node.failureSummary || v.description || '').replace(/\s+/g, ' ').trim(),
        help_url: v.helpUrl,
        route,
        selector: Array.isArray(node.target[0]) ? node.target[0].join(' ') : node.target.join(' '),
        html: node.html,
      });
    });
  }
  return out;
}

/** Custom rule: keyboard-trap (WCAG 2.1.2). */
async function probeKeyboardTraps(page, url, route, maxTabs) {
  const triggerCount = await page.locator('button:visible, [role="button"]:visible').count();
  const found = [];
  const seenDialogs = new Set();
  for (let t = 0; t < triggerCount; t++) {
    await page.goto(url, { waitUntil: 'networkidle' });
    const trigger = page.locator('button:visible, [role="button"]:visible').nth(t);
    if ((await trigger.count()) === 0) continue;
    // skip controls that already live inside a dialog on the base page
    if (await trigger.evaluate((el) => !!el.closest('[role="dialog"], dialog, [aria-modal="true"]'))) continue;
    const triggerSelector = await trigger.evaluate(uniqueSelectorFn);
    await trigger.focus();
    await page.keyboard.press('Enter'); // keyboard activation, like a screen-reader user
    await page.waitForTimeout(250);
    const dialog = page.locator('[role="dialog"]:visible, dialog[open]:visible, [aria-modal="true"]:visible').first();
    const dialogCount = await dialog.count();
    if (process.env.A11Y_DEBUG) console.error(`[trap] trigger ${t} ${triggerSelector}: dialogs=${dialogCount}`);
    if (dialogCount === 0) continue;
    const dialogSelector = await dialog.evaluate(uniqueSelectorFn);
    if (seenDialogs.has(dialogSelector)) continue;
    seenDialogs.add(dialogSelector);
    const dialogHtml = await dialog.evaluate((el) => el.outerHTML.slice(0, el.outerHTML.indexOf('>') + 1));

    const keys = [];
    // 1) Does Escape close it?
    await page.keyboard.press('Escape'); keys.push('Escape');
    await page.waitForTimeout(150);
    const closedByEscape = (await dialog.count()) === 0 || !(await dialog.isVisible());
    let focusLeft = false;
    let closeControl = null;
    let unreachable = [];
    let focusables = [];
    // Which focusable elements inside the dialog does Tab actually reach? (checked even if Escape works)
    if (closedByEscape) { await page.goto(url, { waitUntil: 'networkidle' }); await page.locator('button:visible, [role="button"]:visible').nth(t).focus(); await page.keyboard.press('Enter'); await page.waitForTimeout(250); }
    {
      focusables = await page.evaluate((sel) => {
        const d = document.querySelector(sel); if (!d) return [];
        return Array.from(d.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter((el) => !el.disabled && el.offsetParent !== null).map((el, i) => (el.id ? '#' + CSS.escape(el.id) : el.tagName.toLowerCase() + (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30).replace(/\s+/g, ' ') + '#' + i));
      }, dialogSelector);
      const reached = new Set();
      for (let i = 0; i < Math.max(maxTabs, focusables.length * 2); i++) {
        await page.keyboard.press('Tab');
        const cur = await page.evaluate((sel) => { const d = document.querySelector(sel); const a = document.activeElement; if (!d || !a || !d.contains(a)) return null; const els = Array.from(d.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter((el) => !el.disabled && el.offsetParent !== null); const i = els.indexOf(a); return i < 0 ? null : (a.id ? '#' + CSS.escape(a.id) : a.tagName.toLowerCase() + (a.textContent || a.getAttribute('aria-label') || '').trim().slice(0, 30).replace(/\s+/g, ' ') + '#' + i); }, dialogSelector);
        if (cur == null) break; // focus left the dialog (or dialog closed)
        reached.add(cur);
      }
      unreachable = focusables.filter((f) => !reached.has(f));
      // reopen a clean state for the trap checks below
      await page.goto(url, { waitUntil: 'networkidle' }); await page.locator('button:visible, [role="button"]:visible').nth(t).focus(); await page.keyboard.press('Enter'); await page.waitForTimeout(250);
      if (!closedByEscape) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
    }
    if (!closedByEscape) {
      // 2) Can Tab leave the dialog?
      for (let i = 0; i < maxTabs; i++) {
        await page.keyboard.press('Tab'); keys.push('Tab');
        const inside = await page.evaluate((sel) => {
          const d = document.querySelector(sel);
          const a = document.activeElement;
          return !!(d && a && d.contains(a));
        }, dialogSelector);
        if (!inside) { focusLeft = true; break; }
      }
      // 3) Is there a reachable close/cancel/dismiss control inside?
      closeControl = await dialog.evaluate((d) => {
        const rx = /\b(close|dismiss|cancel)\b|×|✕/i;
        for (const el of d.querySelectorAll('button, [role="button"], a[href]')) {
          const name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').trim();
          if (rx.test(name)) return name;
        }
        return null;
      });
    }
    if (unreachable.length && (await dialog.count()) > 0) {
      found.push({
        id: `keyboard-unreachable#${found.filter((f) => f.rule_id === 'keyboard-unreachable').length}`,
        rule_id: 'keyboard-unreachable',
        source_tool: 'custom',
        impact: 'serious',
        wcag: ['wcag2a', 'wcag211'],
        description: 'Some controls inside the dialog can never receive keyboard focus',
        help: `Tab cycling inside the dialog skips: ${unreachable.join(', ')}. Every focusable control in the dialog must be reachable with Tab/Shift+Tab (move focus to the next/previous focusable element instead of always jumping to one element).`,
        help_url: 'https://www.w3.org/WAI/WCAG21/Understanding/keyboard.html',
        route,
        selector: dialogSelector,
        html: dialogHtml,
        repro: { open_selector: triggerSelector, keys: Array(Math.max(maxTabs, 4)).fill('Tab'), observed: `after repeated Tab presses focus only visited ${[...focusables.filter((f) => !unreachable.includes(f))].join(', ') || 'nothing'}; never reached ${unreachable.join(', ')}` },
      });
    }
    const trapped = !closedByEscape && !focusLeft && !closeControl;
    if (process.env.A11Y_DEBUG) console.error(`[trap] ${dialogSelector}: closedByEscape=${closedByEscape} focusLeft=${focusLeft} closeControl=${closeControl} -> trapped=${trapped}`);
    if (trapped) {
      found.push({
        id: `keyboard-trap#${found.length}`,
        rule_id: 'keyboard-trap',
        source_tool: 'custom',
        impact: 'critical',
        wcag: ['wcag2a', 'wcag212'],
        description: 'Keyboard focus can enter the dialog but cannot leave it',
        help: 'Escape must close the dialog and return focus to the element that opened it; provide a focusable Close control inside the dialog. Keep Tab cycling inside the dialog while it is open.',
        help_url: 'https://www.w3.org/WAI/WCAG21/Understanding/no-keyboard-trap.html',
        route,
        selector: dialogSelector,
        html: dialogHtml,
        repro: {
          open_selector: triggerSelector,
          keys,
          observed: `focus never left ${dialogSelector} after ${maxTabs} Tab presses; dialog still open after Escape; no close/cancel control inside`,
        },
      });
    }
  }
  return found;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const browser = await launchBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  const violations = [];
  const base = args.url.replace(/\/+$/, '');
  for (const route of args.routes) {
    const url = base + (route.startsWith('/') ? route : '/' + route);
    await page.goto(url, { waitUntil: 'networkidle' });
    violations.push(...(await runAxe(page, route)));
    violations.push(...(await probeKeyboardTraps(page, url, route, args.trapTabs)));
  }
  await browser.close();
  const report = {
    schema_version: '1.0',
    scan: { tool: `axe-core@${AXE_VERSION}+playwright`, app_url: args.url, app_root: args.appRoot, timestamp: new Date().toISOString() },
    violations,
  };
  const json = JSON.stringify(report, null, 2);
  if (args.out) writeFileSync(args.out, json);
  process.stdout.write(json + '\n');
}

main().catch((err) => { console.error(err); process.exit(2); });
