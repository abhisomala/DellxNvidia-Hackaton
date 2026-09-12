#!/usr/bin/env node
// Vision capture: the pixels and layout facts GuardRail's vision judge (gemma4:26b) looks at.
//
// axe-core reads the DOM; this captures what a sighted user actually sees, for the
// WCAG checks that only make sense on rendered pixels:
//   - full-page screenshots at 1280px (desktop) and 320px (the WCAG 1.4.10 reflow width,
//     equivalent to 1280px at 400% zoom), plus the section regions they are cropped into
//   - keyboard focus pairs: every control reached by real Tab presses, screenshotted
//     focused and (on a fresh load, same scroll position) unfocused
//   - axe's own "needs review" colour-contrast nodes (gradients, images, overlaps), which
//     axe cannot resolve from computed CSS, and text drawn over background images
//   - interactive elements under 44 CSS px at the 320px width (touch target candidates)
//   - an element map (selector, text, page rect, styles) so a model's bounding box can be
//     grounded back to a real element, and the known axe/keyboard findings resolved onto it
//
// It judges nothing itself: pixel diffs, grounding and the model calls live in
// pipeline/vision_audit.py. The capture only records.
//
// Usage: node scripts/vision-capture.js <target file or URL> --out <dir> [--known <axe-shaped report>]
// Exit: 0 = captured, 2 = harness error (nothing usable was captured).

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const DESKTOP = { id: 'desktop', width: 1280, height: 800, deviceScaleFactor: 2 };
const REFLOW = { id: 'reflow-320', width: 320, height: 640, deviceScaleFactor: 2 };

const LAUNCH_TIMEOUT_MS = 30000;
const GOTO_TIMEOUT_MS = 20000;
const ACTION_TIMEOUT_MS = 5000;
const FONT_WAIT_MS = 5000;
const WATCHDOG_MS = 150000;

const MAX_ELEMENTS = 700;
const MAX_FOCUS_STOPS = 18;
const FOCUS_PAD = 12;
const CONTRAST_PAD = 18;
const MAX_CONTRAST = 10;
const MAX_TARGETS = 12;
const TOUCH_MIN = 44;
const REGION_MAX_HEIGHT = { desktop: 1000, 'reflow-320': 760 };

const FOCUSABLE_SELECTOR =
  'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

class HarnessError extends Error {}

function parseArgs(argv) {
  const args = { target: null, out: null, known: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out' || arg === '--known') {
      if (!argv[i + 1]) throw new HarnessError(`${arg} needs a path`);
      args[arg.slice(2)] = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new HarnessError(`unknown option ${arg}`);
    } else if (args.target === null) {
      args.target = arg;
    } else {
      throw new HarnessError(`unexpected argument ${arg}`);
    }
  }
  if (!args.target) throw new HarnessError('usage: vision-capture.js <target> --out <dir> [--known <report.json>]');
  if (!args.out) throw new HarnessError('--out <dir> is required');
  return args;
}

function resolveUrl(target) {
  if (/^(https?|file):\/\//.test(target)) return target;
  if (!fs.existsSync(target)) throw new HarnessError(`target file not found: ${target}`);
  return 'file://' + path.resolve(target);
}

function knownFindings(file) {
  if (!file) return [];
  let report;
  try {
    report = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new HarnessError(`cannot read --known report ${file}: ${err.message}`);
  }
  const out = [];
  for (const violation of report.violations || []) {
    for (const node of violation.nodes || []) {
      out.push({ rule: violation.id, selector: (node.target || []).join(' ') });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// In-page helpers (installed per page; state lives on window.__vision)
// ---------------------------------------------------------------------------
function installHelpers({ maxElements, focusableSelector }) {
  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    if (typeof el.checkVisibility === 'function' &&
        !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const segment = (el) => {
    let seg = el.tagName.toLowerCase();
    for (const cls of el.classList) seg += '.' + CSS.escape(cls);
    const parent = el.parentElement;
    if (parent) {
      const same = [...parent.children].filter((c) => c.tagName === el.tagName);
      if (same.filter((c) => c.matches(seg)).length > 1) seg += `:nth-of-type(${same.indexOf(el) + 1})`;
    }
    return seg;
  };
  const isUniqueId = (el) => el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1;
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
  const ownText = (el) => [...el.childNodes]
    .filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
  const label = (el) => {
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    const value = text || el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
      el.getAttribute('title') || el.getAttribute('alt') || '';
    return value.length > 80 ? value.slice(0, 77) + '...' : value;
  };
  const openingTag = (el) => {
    const attrs = [...el.attributes].map((a) => ` ${a.name}="${a.value.replace(/"/g, '&quot;')}"`).join('');
    const tag = `<${el.tagName.toLowerCase()}${attrs}>`;
    return tag.length > 240 ? tag.slice(0, 237) + '...' : tag;
  };
  const pageRect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
  };
  const effectiveBackground = (el) => {
    let backgroundImage = false;
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      const style = getComputedStyle(cur);
      if (style.backgroundImage && style.backgroundImage !== 'none') backgroundImage = true;
      const color = style.backgroundColor;
      if (color && color !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(color)) {
        return { color, backgroundImage };
      }
    }
    return { color: 'rgb(255, 255, 255)', backgroundImage };
  };
  const interactive = (el) => el.matches(focusableSelector) || el.matches('[role="button"], [role="link"], [onclick]');

  const tracked = [];
  const elements = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (elements.length >= maxElements) break;
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'BR'].includes(el.tagName)) continue;
    if (!isVisible(el)) continue;
    const style = getComputedStyle(el);
    const text = ownText(el);
    const isInteractive = interactive(el);
    const media = ['IMG', 'SVG', 'CANVAS', 'VIDEO', 'PICTURE'].includes(el.tagName.toUpperCase());
    const backdrop = style.backgroundImage && style.backgroundImage !== 'none';
    const block = el.parentElement === document.body || el.tagName === 'SECTION' || el.tagName === 'MAIN';
    const leaf = el.children.length === 0; // e.g. a status dot drawn purely with CSS
    if (!text && !isInteractive && !media && !backdrop && !block && !leaf) continue;
    const bg = effectiveBackground(el);
    tracked.push(el);
    elements.push({
      id: elements.length,
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      text: label(el),
      own_text: text.slice(0, 80),
      interactive: isInteractive,
      rect: pageRect(el),
      font_size_px: parseFloat(style.fontSize),
      font_weight: style.fontWeight,
      letter_spacing: style.letterSpacing,
      line_height: style.lineHeight,
      color: style.color,
      background: bg.color,
      background_image_behind: bg.backgroundImage,
      html: openingTag(el),
      known_rules: [],
    });
  }

  window.__vision = { isVisible, selectorFor, label, pageRect, tracked, elements };
  return true;
}

function markKnown({ known }) {
  const { tracked, elements } = window.__vision;
  const resolved = [];
  for (const finding of known) {
    let el = null;
    try { el = finding.selector ? document.querySelector(finding.selector) : null; } catch { el = null; }
    resolved.push({ ...finding, resolved: Boolean(el) });
    if (!el) continue;
    tracked.forEach((candidate, i) => {
      if (candidate === el || el.contains(candidate) || candidate.contains(el)) {
        const rules = elements[i].known_rules;
        const relation = candidate === el ? 'same' : el.contains(candidate) ? 'inside' : 'contains';
        rules.push({ rule: finding.rule, selector: finding.selector, relation });
      }
    });
  }
  return resolved;
}

function regionsFor({ maxHeight }) {
  const { isVisible, selectorFor, pageRect } = window.__vision;
  const blocks = [];
  for (const child of document.body.children) {
    if (!isVisible(child) || ['SCRIPT', 'STYLE'].includes(child.tagName)) continue;
    if (child.tagName === 'MAIN' || child.getAttribute('role') === 'main') {
      for (const inner of child.children) if (isVisible(inner)) blocks.push(inner);
    } else {
      blocks.push(child);
    }
  }
  const regions = [];
  for (const el of blocks) {
    const rect = pageRect(el);
    if (rect.height < 8) continue;
    const width = Math.min(rect.width, document.documentElement.scrollWidth - rect.x);
    const chunks = Math.max(1, Math.ceil(rect.height / maxHeight));
    const step = rect.height / chunks;
    for (let c = 0; c < chunks; c += 1) {
      regions.push({
        id: `${regions.length}`,
        selector: selectorFor(el),
        chunk: c,
        chunks,
        rect: { x: Math.max(0, rect.x), y: rect.y + c * step, width, height: step },
      });
    }
  }
  return regions;
}

// ---------------------------------------------------------------------------
// Browser driving
// ---------------------------------------------------------------------------
async function openPage(browser, url, viewport, pageErrors) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  page.on('pageerror', (err) => pageErrors.push(String(err && err.message ? err.message : err)));
  try {
    const response = await page.goto(url, { waitUntil: 'load', timeout: GOTO_TIMEOUT_MS });
    if (response && !response.ok() && !url.startsWith('file://')) {
      throw new HarnessError(`loading ${url} returned HTTP ${response.status()}`);
    }
    await page.evaluate((ms) => Promise.race([
      document.fonts ? document.fonts.ready : Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, ms)),
    ]), FONT_WAIT_MS);
    // Instant scrolling so a screenshot is never taken mid-animation.
    await page.addStyleTag({ content: 'html, body { scroll-behavior: auto !important; }' });
    await settle(page);
  } catch (err) {
    await context.close().catch(() => {});
    if (err instanceof HarnessError) throw err;
    throw new HarnessError(`could not load ${url} at ${viewport.width}px: ${err.message}`);
  }
  return { page, close: () => context.close().catch(() => {}) };
}

async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 60)));
  }));
}

async function scrollTo(page, y) {
  await page.evaluate((top) => window.scrollTo({ top, left: 0, behavior: 'instant' }), y);
  await settle(page);
  return page.evaluate(() => window.scrollY);
}

async function captureViewport(browser, url, viewport, outDir, known, pageErrors) {
  const { page, close } = await openPage(browser, url, viewport, pageErrors);
  try {
    await page.evaluate(installHelpers, { maxElements: MAX_ELEMENTS, focusableSelector: FOCUSABLE_SELECTOR });
    const knownResolved = await page.evaluate(markKnown, { known });
    const facts = await page.evaluate(() => ({
      title: document.title,
      scroll_width: document.documentElement.scrollWidth,
      client_width: document.documentElement.clientWidth,
      page_height: document.documentElement.scrollHeight,
    }));
    const regions = await page.evaluate(regionsFor, { maxHeight: REGION_MAX_HEIGHT[viewport.id] });
    const elements = await page.evaluate(() => window.__vision.elements);
    const file = `${viewport.id}-full.png`;
    await page.screenshot({ path: path.join(outDir, file), fullPage: true });
    return { page, close, record: {
      ...viewport, ...facts, screenshot: file, regions, elements, known_resolved: knownResolved,
    } };
  } catch (err) {
    await close();
    throw err;
  }
}

// axe's own verdicts on colour contrast: violations it is sure of, and "incomplete"
// nodes it could not decide (gradient, image or overlapping backgrounds).
async function contrastCandidates(page, elements) {
  await page.addScriptTag({ content: axeSource });
  const result = await page.evaluate(async () => {
    const r = await window.axe.run(document, { runOnly: { type: 'rule', values: ['color-contrast'] } });
    const pick = (list) => list.flatMap((rule) => rule.nodes.map((node) => {
      const selector = node.target.join(' ');
      const el = document.querySelector(selector);
      const check = [...(node.any || []), ...(node.all || []), ...(node.none || [])][0] || {};
      return {
        axe_selector: selector,
        selector: el ? window.__vision.selectorFor(el) : selector,
        text: el ? window.__vision.label(el) : '',
        rect: el ? window.__vision.pageRect(el) : null,
        color: el ? getComputedStyle(el).color : null,
        axe_reason: (check.data && check.data.messageKey) || null,
        axe_message: check.message || null,
        fg_color: check.data && check.data.fgColor,
        font_size: check.data && check.data.fontSize,
        font_weight: check.data && check.data.fontWeight,
      };
    }));
    return { incomplete: pick(r.incomplete), violations: pick(r.violations) };
  });
  const candidates = result.incomplete
    .filter((c) => c.rect)
    .map((c) => ({ ...c, why: `axe-incomplete:${c.axe_reason || 'unknown'}` }));
  const seen = new Set(candidates.map((c) => c.selector));
  for (const el of elements) {
    if (candidates.length >= MAX_CONTRAST) break;
    if (!el.own_text || !el.background_image_behind || seen.has(el.selector)) continue;
    seen.add(el.selector);
    candidates.push({
      selector: el.selector, axe_selector: null, text: el.text, rect: el.rect,
      color: el.color, axe_reason: null, axe_message: null, fg_color: el.color, font_size: `${el.font_size_px}px`,
      font_weight: el.font_weight, why: 'text-over-background-image',
    });
  }
  return { candidates: candidates.slice(0, MAX_CONTRAST), axe_violations: result.violations };
}

// Each candidate twice with the same clip: as rendered, and with only its text made
// transparent, so the pixels behind the glyphs can be measured against its colour.
async function contrastShots(page, candidates, outDir, viewport) {
  for (const [index, c] of candidates.entries()) {
    const top = Math.max(0, c.rect.y - viewport.height / 3);
    const scrollY = await scrollTo(page, top);
    const clip = {
      x: Math.max(0, c.rect.x - CONTRAST_PAD),
      y: Math.max(0, c.rect.y - scrollY - CONTRAST_PAD),
      width: c.rect.width + 2 * CONTRAST_PAD,
      height: c.rect.height + 2 * CONTRAST_PAD,
    };
    clip.width = Math.min(clip.width, viewport.width - clip.x);
    clip.height = Math.min(clip.height, viewport.height - clip.y);
    if (clip.width < 2 || clip.height < 2) continue;
    const name = `contrast-${String(index).padStart(2, '0')}`;
    c.clip = clip;
    c.text_rect_in_clip = { x: c.rect.x - clip.x, y: c.rect.y - scrollY - clip.y, width: c.rect.width, height: c.rect.height };
    c.rendered = `${name}-rendered.png`;
    await page.screenshot({ path: path.join(outDir, c.rendered), clip });
    const hidden = await page.evaluate((selector) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      el.dataset.guardrailColor = el.style.color;
      el.style.setProperty('color', 'transparent', 'important');
      el.style.setProperty('text-shadow', 'none', 'important');
      return true;
    }, c.selector);
    if (!hidden) continue;
    await settle(page);
    c.background = `${name}-background.png`;
    await page.screenshot({ path: path.join(outDir, c.background), clip });
    await page.evaluate((selector) => {
      const el = document.querySelector(selector);
      el.style.removeProperty('text-shadow');
      el.style.color = el.dataset.guardrailColor || '';
      delete el.dataset.guardrailColor;
    }, c.selector);
  }
}

// Real Tab presses from the top of a fresh page; each stop is screenshotted focused,
// then the same clip is taken on a fresh load at the same scroll position, unfocused.
async function focusPairs(browser, url, viewport, outDir, pageErrors) {
  const stops = [];
  const first = await openPage(browser, url, viewport, pageErrors);
  try {
    await first.page.evaluate(installHelpers, { maxElements: 1, focusableSelector: FOCUSABLE_SELECTOR });
    const seen = new Set();
    for (let press = 1; press <= MAX_FOCUS_STOPS + 2 && stops.length < MAX_FOCUS_STOPS; press += 1) {
      await first.page.keyboard.press('Tab');
      await settle(first.page);
      const info = await first.page.evaluate((pad) => {
        const el = document.activeElement;
        if (!el || el === document.body || el === document.documentElement) return null;
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          selector: window.__vision.selectorFor(el),
          text: window.__vision.label(el),
          tag: el.tagName.toLowerCase(),
          rect: window.__vision.pageRect(el),
          scroll_y: window.scrollY,
          clip: {
            x: Math.max(0, r.left - pad),
            y: Math.max(0, r.top - pad),
            right: Math.min(window.innerWidth, r.right + pad),
            bottom: Math.min(window.innerHeight, r.bottom + pad),
          },
          focus_style: {
            outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
            outline_offset: style.outlineOffset,
            box_shadow: style.boxShadow,
            matches_focus_visible: el.matches(':focus-visible'),
          },
        };
      }, FOCUS_PAD);
      if (!info) continue;
      if (seen.has(info.selector)) break; // wrapped around
      seen.add(info.selector);
      const clip = { x: info.clip.x, y: info.clip.y, width: info.clip.right - info.clip.x, height: info.clip.bottom - info.clip.y };
      if (clip.width < 2 || clip.height < 2) continue;
      const index = stops.length;
      const after = `focus-${String(index).padStart(2, '0')}-focused.png`;
      await first.page.screenshot({ path: path.join(outDir, after), clip });
      stops.push({ index, tab_press: press, ...info, clip, focused: after });
    }
  } finally {
    await first.close();
  }

  const second = await openPage(browser, url, viewport, pageErrors);
  try {
    await second.page.mouse.move(0, 0);
    for (const stop of stops) {
      const y = await scrollTo(second.page, stop.scroll_y);
      stop.unfocused = `focus-${String(stop.index).padStart(2, '0')}-unfocused.png`;
      stop.scroll_matched = Math.abs(y - stop.scroll_y) < 1;
      await second.page.screenshot({ path: path.join(outDir, stop.unfocused), clip: stop.clip });
    }
  } finally {
    await second.close();
  }
  return stops;
}

function hiddenAtReflow(desktop, reflow) {
  const visibleNarrow = new Set(reflow.elements.map((e) => e.selector));
  return desktop.elements
    .filter((e) => (e.interactive || e.own_text) && !visibleNarrow.has(e.selector))
    .map((e) => ({ selector: e.selector, text: e.text, interactive: e.interactive, desktop_rect: e.rect }));
}

function overflowAtReflow(reflow) {
  return reflow.elements
    .filter((e) => (e.own_text || e.interactive) && (e.rect.x + e.rect.width > reflow.client_width + 1 || e.rect.x < -1))
    .map((e) => ({ selector: e.selector, text: e.text, rect: e.rect }));
}

function targetCandidates(reflow) {
  const interactive = reflow.elements.filter((e) => e.interactive);
  const centre = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  return interactive
    .filter((e) => e.rect.width < TOUCH_MIN || e.rect.height < TOUCH_MIN)
    .map((e) => {
      let nearest = null;
      for (const other of interactive) {
        if (other === e) continue;
        const a = centre(e.rect);
        const b = centre(other.rect);
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (!nearest || distance < nearest.distance) nearest = { selector: other.selector, distance: Math.round(distance) };
      }
      return {
        selector: e.selector, text: e.text, rect: e.rect,
        width: Math.round(e.rect.width), height: Math.round(e.rect.height), nearest,
      };
    })
    .sort((a, b) => Math.min(a.width, a.height) - Math.min(b.width, b.height))
    .slice(0, MAX_TARGETS);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = resolveUrl(args.target);
  const outDir = path.resolve(args.out);
  const known = knownFindings(args.known);
  fs.mkdirSync(outDir, { recursive: true });
  // A stale capture must never pass for this one: remove this script's own outputs first.
  for (const name of fs.readdirSync(outDir)) {
    if (name === 'capture.json' || /\.png$/.test(name)) fs.rmSync(path.join(outDir, name), { force: true });
  }
  const pageErrors = [];
  const started = Date.now();

  const browser = await chromium.launch({ timeout: LAUNCH_TIMEOUT_MS }).catch((err) => {
    throw new HarnessError(`could not launch Chromium: ${err.message}`);
  });
  let capture;
  try {
    const desktop = await captureViewport(browser, url, DESKTOP, outDir, known, pageErrors);
    let contrast;
    try {
      contrast = await contrastCandidates(desktop.page, desktop.record.elements);
      await contrastShots(desktop.page, contrast.candidates, outDir, DESKTOP);
    } finally {
      await desktop.close();
    }
    const reflow = await captureViewport(browser, url, REFLOW, outDir, known, pageErrors);
    await reflow.close();
    const focus = await focusPairs(browser, url, DESKTOP, outDir, pageErrors);

    capture = {
      testEngine: { name: 'guardrail-vision-capture', version: '1' },
      url,
      timestamp: new Date().toISOString(),
      capture_ms: Date.now() - started,
      viewports: [desktop.record, reflow.record],
      focus,
      contrast: contrast.candidates,
      axe_contrast_violations: contrast.axe_violations,
      targets: targetCandidates(reflow.record),
      reflow: {
        width: REFLOW.width,
        equivalent: '1280 CSS px at 400% zoom (WCAG 1.4.10)',
        horizontal_overflow_px: Math.max(0, reflow.record.scroll_width - reflow.record.client_width),
        hidden_at_reflow: hiddenAtReflow(desktop.record, reflow.record),
        overflowing: overflowAtReflow(reflow.record),
      },
      known,
      pageErrors: [...new Set(pageErrors)],
    };
  } finally {
    await browser.close().catch(() => {});
  }

  fs.writeFileSync(path.join(outDir, 'capture.json'), JSON.stringify(capture, null, 2));
  const [d, r] = capture.viewports;
  console.log(`vision capture: ${url}`);
  console.log(`  ${d.id}: ${d.width}px, page ${d.page_height}px, ${d.regions.length} region(s), ${d.elements.length} element(s)`);
  console.log(`  ${r.id}: ${r.width}px, page ${r.page_height}px, ${r.regions.length} region(s), ` +
    `overflow ${capture.reflow.horizontal_overflow_px}px, ${capture.reflow.hidden_at_reflow.length} element(s) hidden at 320px`);
  console.log(`  focus stops: ${capture.focus.length}; contrast candidates: ${capture.contrast.length}; ` +
    `small targets: ${capture.targets.length}; ${capture.capture_ms}ms`);
  console.log(`  written to ${path.join(outDir, 'capture.json')}`);
}

const watchdog = setTimeout(() => {
  console.error(`vision-capture: harness error: timed out after ${WATCHDOG_MS / 1000}s`);
  process.exit(2);
}, WATCHDOG_MS);
watchdog.unref();

main().catch((err) => {
  const msg = err instanceof HarnessError ? err.message : (err && err.stack) || String(err);
  console.error(`vision-capture: harness error: ${msg}`);
  process.exitCode = 2;
});
