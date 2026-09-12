const $ = (selector) => document.querySelector(selector);
const dashboardView = $("#dashboard-view");
const detailView = $("#detail-view");
let refreshTimer;
let detailTimer;
const detail = { target: null, data: null, json: "", filter: "all", expanded: new Set(), shotMode: null };

function time(value) {
  if (!value) return "No recorded scan";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
function elapsed(value) {
  if (!value) return "Idle";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`;
}
function escapeHtml(value) { const node = document.createElement("span"); node.textContent = value ?? ""; return node.innerHTML; }
function escapeAttr(value) { return escapeHtml(value).replace(/"/g, "&quot;"); }
// Model recommendations use `backticks` for CSS; render those as code, everything else as text.
function richText(value) { return escapeHtml(value).replace(/`([^`]+)`/g, "<code>$1</code>"); }
function plural(count, one, many = `${one}s`) { return `${count} ${count === 1 ? one : many}`; }
function sourceOf(finding) { return finding.source === "vision" ? "vision" : "axe"; }
function seconds(value) { return typeof value === "number" ? (value >= 100 ? `${Math.round(value)} s` : `${value.toFixed(1)} s`) : null; }

function activityCopy(activity) {
  if (!activity.active) return "No recent scan event is in progress. GuardRail is standing by.";
  const labels = { scan: "Scanning target", vision: "Vision model judging screenshots", locate: "Locating findings", patch: "Applying code-level remediation", verify: "Verifying remediation", record: "Recording results" };
  return `${labels[activity.stage] || "Processing local audit activity"}. The next event will advance the recorded pipeline.`;
}
function drawActivity(activity) {
  const order = ["scan", "vision", "locate", "patch", "verify", "record"];
  const current = order.indexOf(activity.stage);
  $("#activity-title").textContent = activity.active ? activityCopy(activity).split(".")[0] : "Awaiting a local scan";
  $("#activity-elapsed").textContent = activity.active ? `latest event ${elapsed(activity.timestamp)}` : "Idle";
  $("#activity-copy").textContent = activityCopy(activity);
  document.querySelectorAll(".pipeline li").forEach((item, index) => {
    item.classList.toggle("done", activity.active && index < current);
    item.classList.toggle("active", activity.active && index === current);
    if (activity.active && index === current) item.setAttribute("aria-current", "step"); else item.removeAttribute("aria-current");
  });
}
function showRegistryState(message, error = false) {
  const state = $("#registry-state"); state.textContent = message; state.hidden = false; state.classList.toggle("error", error);
}
function countCell(site) {
  const total = `<span class="count-total">${site.violationCount}</span>`;
  if (typeof site.visionCount !== "number") return total;
  let split = "";
  if (site.visionStatus === "running") split = `${site.axeCount} axe · vision running`;
  else if (site.visionCount > 0 || site.visionStatus) split = `${site.axeCount} axe · ${site.visionCount} vision`;
  return split ? `${total}<span class="count-split">${escapeHtml(split)}</span>` : total;
}
function renderSites(sites) {
  const body = $("#registry-body"); body.innerHTML = ""; $("#registry-state").hidden = true;
  $("#registry-count").textContent = `${sites.length} ${sites.length === 1 ? "target" : "targets"}`;
  if (!sites.length) { showRegistryState("No scan records have been stored yet. Start a scan to register a target."); return; }
  sites.forEach((site) => {
    const row = document.createElement("tr");
    const trigger = site.triggerSource ? `<span class="trigger-tag">${escapeHtml(site.triggerSource)}</span>` : "<span class=\"trigger-tag\">unknown</span>";
    row.innerHTML = `<td><button class="site-button" type="button">${escapeHtml(site.targetApp)}</button></td><td class="mono">${escapeHtml(time(site.lastScan))}</td><td class="mono">${countCell(site)}</td><td><span class="status ${site.status.replace(" ", "-")}">${escapeHtml(site.status)}</span></td><td>${trigger}</td>`;
    row.querySelector("button").addEventListener("click", () => openSite(site.targetApp)); body.appendChild(row);
  });
}
function drawHeartbeat(heartbeat) {
  const output = $("#watch-status");
  if (!heartbeat.watching_since || !heartbeat.next_scan_at) { output.textContent = "Watcher unavailable"; return; }
  const watchedSeconds = Math.max(0, Math.floor((Date.now() - new Date(heartbeat.watching_since).getTime()) / 1000));
  const nextSeconds = Math.max(0, Math.ceil((new Date(heartbeat.next_scan_at).getTime() - Date.now()) / 1000));
  const duration = watchedSeconds < 60 ? `${watchedSeconds}s` : `${Math.floor(watchedSeconds / 60)}m ${watchedSeconds % 60}s`;
  output.textContent = `Watching since ${time(heartbeat.watching_since)} · ${duration} · next automatic scan in ${nextSeconds}s`;
}
async function loadHeartbeat() {
  try { const response = await fetch("/api/heartbeat"); drawHeartbeat(await response.json()); } catch { $("#watch-status").textContent = "Watcher unavailable"; }
}
async function loadDashboard() {
  try {
    const response = await fetch("/api/dashboard"); const data = await response.json();
    if (!response.ok) throw new Error(data.error || "MongoDB could not be reached");
    $("#sites-total").textContent = data.summary.sitesMonitored;
    $("#fixes-total").textContent = data.summary.fixesLogged;
    $("#refresh-note").textContent = data.isFallback ? "Local demo scan · MongoDB unavailable" : (runActive ? "Live read from MongoDB · run in progress, refreshing every 2s" : "Live read from MongoDB · refreshes every 15s");
    runActive = Boolean(data.activity.active); drawActivity(data.activity); renderSites(data.sites);
    if (data.isFallback) showRegistryState("Showing the most recent real local axe scan of demo/index.html. It is not a persisted MongoDB record.");
  } catch (error) {
    $("#refresh-note").textContent = "Local store unavailable";
    drawActivity({ active: false }); renderSites([]);
    showRegistryState("MongoDB is unavailable. Check MONGODB_URI and MONGODB_DATABASE, then reload. No data is shown.", true);
  }
}
function renderTrend(history) {
  const chart = $("#trend-chart"); chart.innerHTML = ""; document.querySelectorAll(".trend-legend").forEach((node) => node.remove());
  if (history.length < 2) { chart.innerHTML = '<p class="chart-note">Not enough history yet. A trend appears after a second scan.</p>'; return; }
  const max = Math.max(...history.map((point) => point.violationCount), 1);
  const split = history.some((point) => typeof point.visionCount === "number" && (point.visionCount > 0 || point.visionStatus));
  history.slice(-12).forEach((point) => {
    const bar = document.createElement("div"); bar.className = "bar";
    const vision = split ? point.visionCount || 0 : 0;
    const dom = point.violationCount - vision;
    const pending = point.visionStatus === "running";
    const label = split ? `${point.violationCount} findings: ${dom} DOM, ${pending ? "vision still running" : `${vision} vision`}` : `${point.violationCount} findings`;
    const visionShare = point.violationCount ? vision / point.violationCount * 100 : 0;
    bar.innerHTML = `<b>${point.violationCount}${pending ? "<small>+?</small>" : ""}</b><i class="${pending ? "pending" : ""}" style="height:${Math.max(3, point.violationCount / max * 100)}%" title="${escapeAttr(label)}">${vision ? `<em style="height:${visionShare}%"></em>` : ""}</i><span title="${escapeHtml(time(point.timestamp))}">${new Date(point.timestamp).toLocaleDateString(undefined, { month:"short", day:"numeric" })}<span class="sr-only">: ${escapeHtml(label)}</span></span>`;
    chart.appendChild(bar);
  });
  const legend = document.createElement("p"); legend.className = "trend-legend";
  legend.innerHTML = split ? '<span class="key dom"></span>DOM (axe) <span class="key vision"></span>vision <span class="key pending"></span>vision still running' : "";
  if (split) chart.after(legend);
}

/* ---------- findings ---------- */

const STATUS_LABEL = { verified: "verified", pending: "pending", review: "needs review" };
const VIEWPORT_LABEL = { desktop: "1280px desktop", "reflow-320": "320px reflow" };
const METHOD_LABEL = {
  "pixel-diff+model": "Pixel diff of the focused vs unfocused capture, confirmed by the model",
  "model+pixel-measurement": "Model reading, confirmed by a contrast measurement on the real pixels",
  model: "Model judgement from the screenshot",
};

function img(ref, alt, className = "") {
  const size = ref.width && ref.height ? ` width="${ref.width}" height="${ref.height}"` : "";
  return `<img class="${className}" src="${escapeAttr(ref.url)}" alt="${escapeAttr(alt)}"${size} loading="lazy" decoding="async" />`;
}
function confidenceCell(finding) {
  if (sourceOf(finding) !== "vision") return '<span class="confidence rule-based" title="Deterministic DOM rule: no model involved">rule-based</span>';
  if (typeof finding.confidence !== "number") return '<span class="confidence">confidence unknown</span>';
  const pct = Math.round(finding.confidence * 100);
  return `<span class="confidence" title="Model confidence ${pct}%"><span class="meter" aria-hidden="true"><i style="width:${pct}%"></i></span><span>${pct}%<span class="sr-only"> model confidence</span></span></span>`;
}
function wcagLink(finding) {
  if (!finding.helpUrl) return "";
  const slug = (finding.helpUrl.match(/Understanding\/([^/.?#]+)/) || [])[1];
  const name = slug ? slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "rule reference";
  const criteria = finding.wcag && finding.wcag.length ? `WCAG ${finding.wcag.join(", ")} · ` : "";
  const label = sourceOf(finding) === "vision" || slug ? `${criteria}Understanding ${name}` : `${criteria}axe rule reference`;
  return `<a href="${escapeAttr(finding.helpUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}<span class="sr-only"> (opens in a new tab)</span> <span aria-hidden="true">↗</span></a>`;
}
function gatesHtml(finding) {
  if (!finding.gates || !finding.gates.length) return "";
  const chips = finding.gates.map((gate) => `<li class="gate ${escapeAttr(gate.status)}"><span>${escapeHtml(gate.name)}</span> ${escapeHtml(gate.status)}</li>`).join("");
  return `<div class="gates"><p class="gates-title">Verification gates</p><ul>${chips}</ul></div>`;
}
function visionMedia(finding) {
  const where = VIEWPORT_LABEL[finding.viewport] || finding.viewport || "page";
  const subject = finding.elementText ? `"${finding.elementText}"` : finding.selector;
  const shots = [];
  if (finding.evidenceImage) {
    shots.push(`<figure class="evidence-shot">${img(finding.evidenceImage, `Screenshot crop at ${where} showing ${subject} (${finding.selector}): ${finding.description || finding.ruleId}`)}<figcaption>Evidence crop · ${escapeHtml(where)}${finding.number ? ` · marker ${finding.number}` : ""}</figcaption></figure>`);
  }
  if (finding.modelImage && (!finding.evidenceImage || finding.modelImage.path !== finding.evidenceImage.path)) {
    const focus = finding.category === "focus-visible";
    const contrast = finding.category === "contrast";
    const alt = focus ? `Side-by-side capture of ${subject}: unfocused on the left, keyboard-focused on the right`
      : contrast ? `Capture of ${subject} rendered over its real background, as measured for contrast`
      : `Page region the model judged, containing ${subject}`;
    const caption = focus ? "Model input · unfocused (left) vs focused (right)" : contrast ? "Model input · text over its real background" : "Model input · region judged";
    shots.push(`<figure class="evidence-shot">${img(finding.modelImage, alt)}<figcaption>${caption}</figcaption></figure>`);
  }
  const missing = (finding.imagesDeclared || []).length > shots.length && shots.length === 0
    ? `<p class="missing-artifact">The evidence image${finding.imagesDeclared.length > 1 ? "s" : ""} recorded for this finding (${escapeHtml(finding.imagesDeclared.join(", "))}) ${finding.imagesDeclared.length > 1 ? "are" : "is"} not available on this machine.</p>` : "";
  return shots.length ? `<div class="evidence-grid">${shots.join("")}</div>` : missing;
}
function detailHtml(finding) {
  const vision = sourceOf(finding) === "vision";
  const facts = [];
  if (finding.evidence) facts.push(["Evidence", vision ? `<p>${escapeHtml(finding.evidence)}</p>` : `<pre>${escapeHtml(finding.evidence)}</pre>`]);
  if (finding.help) facts.push([vision ? "Recommendation" : "Rule", `<p>${richText(finding.help)}</p>`]);
  if (vision && finding.method) {
    const method = METHOD_LABEL[finding.method] || finding.method;
    facts.push(["Method", `<p>${escapeHtml(method)} <span class="mono-note">${escapeHtml(finding.method)}${finding.grounding ? ` · ${escapeHtml(finding.grounding)} grounding` : ""}${finding.viewport ? ` · ${escapeHtml(VIEWPORT_LABEL[finding.viewport] || finding.viewport)}` : ""}</span></p>`]);
  }
  if (!vision && finding.scanner) facts.push(["Scanner", `<p class="mono-note">${escapeHtml(finding.scanner)}</p>`]);
  const link = wcagLink(finding);
  if (link) facts.push([vision ? "WCAG" : "Reference", `<p>${link}</p>`]);
  const factsHtml = `<dl class="facts">${facts.map(([term, value]) => `<div><dt>${term}</dt><dd>${value}</dd></div>`).join("")}</dl>`;
  return `<div class="finding-detail${vision ? " vision" : ""}" id="${finding.id}-detail" ${detail.expanded.has(finding.id) ? "" : "hidden"}>${vision ? visionMedia(finding) : ""}${factsHtml}</div>`;
}
function findingHtml(finding) {
  const source = sourceOf(finding);
  const vision = source === "vision";
  const status = finding.fixStatus || "pending";
  const diff = finding.originalSnippet != null && finding.patchedSnippet != null ? `<div class="diff" aria-label="Recorded patch diff"><pre><span class="diff-label">Before</span>${escapeHtml(finding.originalSnippet)}</pre><pre><span class="diff-label">After</span>${escapeHtml(finding.patchedSnippet)}</pre></div>` : "";
  const hasDetail = Boolean(finding.evidence || finding.help || finding.helpUrl || finding.evidenceImage);
  const open = detail.expanded.has(finding.id);
  const toggle = hasDetail ? `<button type="button" class="finding-toggle" aria-expanded="${open}" aria-controls="${finding.id}-detail"><span>${vision ? "Evidence" : "Details"}</span><span class="chev" aria-hidden="true"></span><span class="sr-only"> for ${escapeHtml(finding.ruleId)} on ${escapeHtml(finding.selector)}</span></button>` : '<span class="finding-toggle-placeholder"></span>';
  const marker = vision && finding.number ? `<span class="mark-no" title="Marker ${finding.number} on the annotated ${escapeAttr(VIEWPORT_LABEL[finding.viewport] || "")} screenshot">${finding.number}</span>` : "";
  const second = vision ? `<div class="finding-desc">${escapeHtml(finding.description || "")}</div>` : `<div class="finding-selector">${escapeHtml(finding.sourceFile)}</div>`;
  return `<article class="finding ${source}" id="${finding.id}" data-source="${source}">
    <div class="finding-main"><div class="finding-title"><span class="source-badge ${source}">${source}</span>${marker}<span class="finding-rule">${escapeHtml(finding.ruleId)}</span></div>${second}</div>
    <div class="finding-selector finding-target" title="${escapeAttr(finding.selector)}">${escapeHtml(finding.selector)}</div>
    <span class="severity">${escapeHtml(finding.severity)}</span>
    ${confidenceCell(finding)}
    <span class="fix-status ${escapeAttr(status)}" ${status === "review" ? 'title="Vision findings are recorded for human review; GuardRail does not auto-patch them"' : ""}>${escapeHtml(STATUS_LABEL[status] || status)}</span>
    ${toggle}${diff}${gatesHtml(finding)}${hasDetail ? detailHtml(finding) : ""}
  </article>`;
}
function applyFilter() {
  const list = detail.data ? detail.data.violations : [];
  const counts = { all: list.length, axe: list.filter((f) => sourceOf(f) === "axe").length, vision: list.filter((f) => sourceOf(f) === "vision").length };
  document.querySelectorAll(".findings-toolbar .chip").forEach((chip) => {
    chip.setAttribute("aria-pressed", String(chip.dataset.filter === detail.filter));
    chip.querySelector("[data-count]").textContent = counts[chip.dataset.filter];
  });
  let shown = 0;
  document.querySelectorAll("#findings-list .finding").forEach((item) => {
    const visible = detail.filter === "all" || item.dataset.source === detail.filter;
    item.hidden = !visible; if (visible) shown += 1;
  });
  const empty = $("#findings-filter-empty");
  if (empty) empty.hidden = shown > 0 || !list.length;
  $("#findings-count").textContent = detail.filter === "all"
    ? plural(list.length, "finding")
    : `showing ${shown} of ${plural(list.length, "finding")}`;
}
function renderFindings(data) {
  const findings = $("#findings-list");
  if (!data.violations.length) { findings.innerHTML = '<p class="empty-finding">This latest scan has no current violations.</p>'; applyFilter(); return; }
  findings.innerHTML = data.violations.map(findingHtml).join("") + '<p class="empty-finding" id="findings-filter-empty" hidden>No findings from this source in the latest scan.</p>';
  applyFilter();
}
function openFinding(id) {
  const item = document.getElementById(id); if (!item) return;
  if (item.hidden) { detail.filter = "all"; applyFilter(); }
  detail.expanded.add(id);
  const panel = document.getElementById(`${id}-detail`); const toggle = item.querySelector(".finding-toggle");
  if (panel) panel.hidden = false; if (toggle) toggle.setAttribute("aria-expanded", "true");
  item.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  (toggle || item).focus({ preventScroll: true });
}

/* ---------- visual review ---------- */

function statusNote(kind, title, body) {
  return `<div class="vision-note ${kind}"><p class="vision-note-title">${title}</p>${body ? `<p>${body}</p>` : ""}</div>`;
}
function modelFacts(va) {
  const facts = [];
  const m = va.model;
  if (m) {
    facts.push(`<li><b>${escapeHtml(m.name || "model")}</b>${m.baseModel && m.baseModel !== m.name ? ` → ${escapeHtml(m.baseModel)}` : ""}${m.parameterSize || m.quantization ? ` <span>${escapeHtml([m.parameterSize, m.quantization].filter(Boolean).join(" · "))}</span>` : ""}</li>`);
    if (m.numCtx) facts.push(`<li>num_ctx <b>${Number(m.numCtx).toLocaleString("en-US")}</b></li>`);
  }
  if (va.thinking) facts.push(`<li>thinking <b>${escapeHtml(va.thinking)}</b></li>`);
  if (seconds(va.latencyS)) facts.push(`<li>latency <b>${seconds(va.latencyS)}</b></li>`);
  if (va.calls && va.calls.total) facts.push(`<li><b>${va.calls.total}</b> model ${va.calls.total === 1 ? "call" : "calls"}${va.calls.failed ? ` · <b class="warn">${va.calls.failed} failed</b>` : ""}</li>`);
  const c = va.cache;
  if (c) {
    if (c.allCached) facts.push('<li class="cache reused">judgement <b>reused</b></li>');
    else if (c.hits) facts.push(`<li class="cache reused"><b>${c.hits} of ${c.calls}</b> calls reused</li>`);
    else facts.push(`<li class="cache">${c.enabled ? "cache on" : "cache off"} · <b>fresh run</b></li>`);
  }
  return facts.length ? `<ul class="model-facts">${facts.join("")}</ul>` : "";
}
function runSentence(va) {
  const c = va.cache || {};
  const cap = va.capture || {};
  const viewports = (cap.viewports || []).map((vp) => vp.id === "desktop" ? `${vp.width}px desktop` : vp.id === "reflow-320" ? `${vp.width}px reflow` : `${vp.id}`).join(" and ");
  const scope = [viewports && `screenshots at ${viewports}`, typeof cap.focusStops === "number" && plural(cap.focusStops, "focus stop"), typeof cap.contrastCandidates === "number" && plural(cap.contrastCandidates, "contrast candidate"), typeof cap.targetCandidates === "number" && plural(cap.targetCandidates, "target-size candidate")].filter(Boolean).join(", ");
  if (c.allCached) {
    const when = c.cachedFrom && c.cachedTo && c.cachedFrom !== c.cachedTo ? `${time(c.cachedFrom)} – ${time(c.cachedTo)}` : time(c.cachedFrom || c.cachedTo);
    return `<p class="run-sentence reused">Judgement reused from ${escapeHtml(when)}: page pixels unchanged, so no new model call was made for this scan.${scope ? ` Captured ${escapeHtml(scope)}.` : ""}</p>`;
  }
  const partialCache = c.hits ? ` ${c.hits} of ${c.calls} calls reused an earlier judgement because those pixels were unchanged.` : "";
  const finished = va.finishedAt ? ` Finished ${escapeHtml(time(va.finishedAt))}.` : "";
  return `<p class="run-sentence">${scope ? `Judged ${escapeHtml(scope)}.` : ""}${partialCache}${finished}</p>`;
}
function scoreTiles(review) {
  const s = review.scores || {};
  const overall = typeof review.overallScore === "number" ? review.overallScore : s.overall;
  const tile = (label, value, big = false) => {
    const known = typeof value === "number";
    const level = !known ? "" : value >= 8 ? "high" : value <= 5 ? "low" : "mid";
    return `<li class="score ${big ? "overall" : ""} ${level}"><span class="score-value">${known ? value : "—"}<small>/10</small></span><span class="score-label">${label}</span>${known ? `<span class="score-meter" aria-hidden="true"><i style="width:${Math.max(0, Math.min(10, value)) * 10}%"></i></span>` : ""}</li>`;
  };
  return `<div class="scores-wrap"><ul class="scores" aria-label="Design scores, model judgement out of 10">${tile("overall", overall, true)}${tile("typography", s.typography)}${tile("color", s.color)}${tile("spacing", s.spacing)}${tile("hierarchy", s.hierarchy)}</ul><p class="scores-note">Model's design judgement with an accessibility lens, 1–10. Not a WCAG pass/fail score.</p></div>`;
}
function shotModes(va, data) {
  const vision = data.violations.filter((f) => sourceOf(f) === "vision");
  const review = va.designReview;
  const annotated = va.annotated || {};
  return [
    { id: "desktop", label: "Findings · 1280px", ref: annotated.desktop, items: vision.filter((f) => f.viewport === "desktop"), kind: "findings", alt: "Annotated 1280px desktop screenshot" },
    { id: "reflow320", label: "Findings · 320px reflow", ref: annotated.reflow320, items: vision.filter((f) => f.viewport === "reflow-320"), kind: "findings", alt: "Annotated 320px-wide reflow screenshot" },
    { id: "design", label: "Design notes", ref: annotated.design, items: review ? review.improvements : [], kind: "design", alt: "Desktop screenshot annotated with numbered design recommendations" },
  ].filter((mode) => mode.ref || mode.items.length);
}
function legendHtml(mode) {
  if (!mode.items.length) return `<p class="legend-empty">${mode.kind === "design" ? "No design recommendations recorded." : "No vision findings at this viewport."}</p>`;
  if (mode.kind === "design") {
    return `<ol class="shot-legend">${mode.items.map((item) => `<li><a href="#rec-${item.number}" class="legend-item"><span class="mark-no design">${item.number}</span><span><span class="legend-meta">${escapeHtml(item.area || "design")}${item.priority ? ` · <span class="priority-text ${escapeAttr(item.priority)}">${escapeHtml(item.priority)}</span>` : ""}</span>${escapeHtml(item.issue || "")}</span></a></li>`).join("")}</ol>`;
  }
  return `<ol class="shot-legend">${mode.items.map((f) => `<li><button type="button" class="legend-item" data-finding="${f.id}"><span class="mark-no">${f.number}</span><span><span class="legend-meta">${escapeHtml(f.category || f.ruleId)} · ${escapeHtml(f.severity)}${typeof f.confidence === "number" ? ` · ${Math.round(f.confidence * 100)}%` : ""}</span>${escapeHtml(f.description || f.selector)}</span></button></li>`).join("")}</ol>`;
}
function viewerHtml(va, data) {
  const modes = shotModes(va, data);
  if (!modes.length) return "";
  if (!modes.some((mode) => mode.id === detail.shotMode)) detail.shotMode = modes[0].id;
  const mode = modes.find((m) => m.id === detail.shotMode);
  const buttons = modes.map((m) => `<button type="button" class="chip" data-shot="${m.id}" aria-pressed="${m.id === mode.id}">${m.label} <span>${m.items.length}</span></button>`).join("");
  const count = mode.kind === "design" ? plural(mode.items.length, "numbered recommendation") : plural(mode.items.length, "numbered finding");
  const frame = mode.ref
    ? `<div class="shot-frame ${mode.id}" tabindex="0" role="region" aria-label="${escapeAttr(`${mode.alt}, scrollable`)}">${img(mode.ref, `${mode.alt} of ${data.targetApp} with ${count}; the numbers are listed alongside.`, "shot")}</div><a class="shot-open" href="${escapeAttr(mode.ref.url)}" target="_blank" rel="noopener">Open full size<span class="sr-only"> (opens in a new tab)</span> <span aria-hidden="true">↗</span></a>`
    : `<p class="missing-artifact">The annotated screenshot for this view is not available on this machine.</p>`;
  return `<div class="viewer"><div class="viewer-main"><div class="filter-chips shot-modes" role="group" aria-label="Annotated screenshot view">${buttons}</div>${frame}</div><div class="viewer-legend"><p class="eyebrow">${mode.kind === "design" ? "Design recommendations on this view" : `Vision findings at ${mode.id === "desktop" ? "1280px" : "320px"}`}</p>${legendHtml(mode)}</div></div>`;
}
function recommendationsHtml(review) {
  if (!review || !review.improvements.length) return "";
  const items = review.improvements.map((item) => `<li class="rec" id="rec-${item.number}" tabindex="-1">
      <div class="rec-head"><span class="mark-no design">${item.number}</span><span class="rec-area">${escapeHtml(item.area || "design")}</span>${item.priority ? `<span class="priority ${escapeAttr(item.priority)}">${escapeHtml(item.priority)} priority</span>` : ""}</div>
      <p class="rec-issue">${richText(item.issue)}</p>
      ${item.recommendation ? `<p class="rec-text"><span class="rec-label">Recommendation</span>${richText(item.recommendation)}</p>` : ""}
      ${item.cssSuggestion ? `<pre class="css-suggestion" aria-label="Suggested CSS"><code>${escapeHtml(item.cssSuggestion)}</code></pre>` : ""}
      ${item.accessibilityBenefit ? `<p class="rec-text"><span class="rec-label">Accessibility benefit</span>${richText(item.accessibilityBenefit)}</p>` : ""}
      ${item.selector || item.visibleText ? `<p class="rec-target">${escapeHtml([item.selector, item.visibleText && `"${item.visibleText}"`].filter(Boolean).join(" · "))}</p>` : ""}
    </li>`).join("");
  return `<div class="recs"><div class="sub-head"><h3>Design recommendations</h3><p>${plural(review.improvements.length, "recommendation")}, numbered as on the design view</p></div><ol class="rec-list">${items}</ol></div>`;
}
function auditFooter(va) {
  const counts = va.counts || {};
  const parts = [`${counts.deduplicated || 0} deduplicated against DOM findings`, `${counts.suppressed || 0} suppressed`];
  if (va.capture && typeof va.capture.captureMs === "number") parts.push(`capture ${seconds(va.capture.captureMs / 1000)}`);
  if (va.engine && va.engine.promptVersion) parts.push(`prompt ${va.engine.promptVersion}`);
  if (va.sampling) parts.push(`temperature ${va.sampling.temperature} · top_p ${va.sampling.top_p} · top_k ${va.sampling.top_k}`);
  const dropped = [...(va.deduplicated || []).map((d) => ({ ...d, kind: "deduplicated" })), ...(va.suppressed || []).map((s) => ({ ...s, kind: "suppressed" }))];
  const droppedHtml = dropped.length ? `<details class="audit-details"><summary>Findings not shown (${dropped.length})</summary><ul>${dropped.map((d) => `<li><b>${escapeHtml(d.kind)}</b> ${escapeHtml(d.category || "")} ${escapeHtml(d.selector || "")}${d.title ? ` · ${escapeHtml(d.title)}` : ""}${d.reason ? ` — ${escapeHtml(d.reason)}` : ""}</li>`).join("")}</ul></details>` : "";
  const tasks = va.tasks || [];
  const tasksHtml = tasks.length ? `<details class="audit-details"><summary>Model calls (${tasks.length})</summary><div class="table-scroll"><table class="task-table"><thead><tr><th scope="col">Call</th><th scope="col">Images</th><th scope="col">Thinking</th><th scope="col">Latency</th><th scope="col">Tokens out</th><th scope="col">Result</th></tr></thead><tbody>${tasks.map((t) => `<tr><td>${escapeHtml(t.name)}</td><td>${t.images ?? "—"}</td><td>${t.think ? "on" : "off"}</td><td>${seconds(t.latencyS) || "—"}</td><td>${t.outputTokens ?? "—"}</td><td>${t.status === "ok" ? (t.cached ? `reused from ${escapeHtml(time(t.cachedAt))}` : "ok") : `<span class="warn">${escapeHtml(t.status || "error")}${t.error ? `: ${escapeHtml(t.error)}` : ""}</span>`}</td></tr>`).join("")}</tbody></table></div></details>` : "";
  return `<div class="audit-footer"><p>${parts.map(escapeHtml).join(" · ")}</p>${droppedHtml}${tasksHtml}</div>`;
}
function renderVisual(data) {
  const va = data.visionAudit;
  const body = $("#visual-body");
  const model = va && va.model ? (va.model.baseModel || va.model.name) : null;
  $("#visual-model").textContent = model || "gemma4:26b";
  const meta = $("#visual-meta");
  if (!va) {
    meta.textContent = "not recorded";
    body.innerHTML = statusNote("absent", "The vision audit did not run for this scan.", "No <code>vision_audit</code> is recorded on this scan document, so only DOM findings (axe-core and the keyboard probe) are shown. Visual-only failures were not checked.");
    return;
  }
  const status = va.status;
  if (status === "running") {
    meta.textContent = "in progress";
    body.innerHTML = `<div class="vision-note running"><p class="vision-note-title"><i class="pulse-dot" aria-hidden="true"></i>Vision audit in progress</p><p>The local vision model is judging screenshots of this page${va.startedAt ? ` · started ${escapeHtml(time(va.startedAt))} (${escapeHtml(elapsed(va.startedAt))})` : ""}. DOM findings above are already recorded; vision findings and the design review appear here when it finishes. This view refreshes every 10 seconds.</p></div>`;
    return;
  }
  if (status === "disabled") {
    meta.textContent = "disabled";
    body.innerHTML = statusNote("absent", "The vision audit was turned off for this run.", `No visual checks ran, so only DOM findings are shown.${va.error ? ` Recorded reason: <code>${escapeHtml(va.error)}</code>` : ""}`);
    return;
  }
  if (status === "unavailable") {
    meta.textContent = "unavailable";
    body.innerHTML = statusNote("error", "The vision audit could not run for this scan.", `${va.error ? `${escapeHtml(va.error)}. ` : ""}Visual checks did not run; only DOM findings are shown.`) + (va.tasks && va.tasks.length ? auditFooter(va) : "");
    return;
  }
  const review = va.designReview;
  const counts = va.counts || {};
  meta.textContent = [plural(counts.findings || 0, "vision finding"), review && plural(review.improvements.length, "design note")].filter(Boolean).join(" · ");
  const partial = status === "partial"
    ? statusNote("warn", "Partial result: some model calls did not complete.", `${va.error ? `${escapeHtml(va.error)}. ` : ""}Findings and scores below come only from the calls that finished.`) : "";
  const unknown = status !== "complete" && status !== "partial"
    ? statusNote("warn", `Vision audit status: ${escapeHtml(status)}.`, va.error ? escapeHtml(va.error) : "") : "";
  const missing = va.missingArtifacts && va.missingArtifacts.length
    ? `<p class="missing-artifact">Recorded artifact files not found on this machine: ${escapeHtml(va.missingArtifacts.join(", "))}.</p>` : "";
  const strip = `<div class="vision-strip"><p class="eyebrow"><i class="status-dot ${escapeAttr(status)}" aria-hidden="true"></i>Vision audit · ${escapeHtml(status)}</p>${modelFacts(va)}${runSentence(va)}</div>`;
  const summary = review ? `<div class="review-summary"><div><p class="eyebrow">Design summary</p><p class="summary-text">${richText(review.summary)}</p></div>${review.strengths.length ? `<div><p class="eyebrow">Strengths</p><ul class="strengths">${review.strengths.map((s) => `<li>${richText(s)}</li>`).join("")}</ul></div>` : ""}</div>` : '<p class="legend-empty">No design review was recorded for this audit.</p>';
  body.innerHTML = `${partial}${unknown}${strip}${review ? scoreTiles(review) : ""}${summary}${missing}${viewerHtml(va, data)}${recommendationsHtml(review)}${auditFooter(va)}`;
}

/* ---------- detail view ---------- */

function renderDetail(data) {
  detail.data = data;
  $("#detail-title").textContent = data.targetApp;
  $("#detail-subtitle").textContent = `Latest scan: ${time(data.latestScan)}.`;
  $("#report-link").href = `/api/report?target=${encodeURIComponent(data.targetApp)}`;
  renderFindings(data);
  renderVisual(data);
  renderTrend(data.history);
  const access = $("#access-list"); access.innerHTML = data.accessPoints.length ? data.accessPoints.map((point) => `<li>${escapeHtml(point)}</li>`).join("") : "<li>No source file or URL has been recorded yet.</li>";
}
function scheduleDetailRefresh(data) {
  clearTimeout(detailTimer);
  const running = (data.visionAudit && data.visionAudit.status === "running") || (data.activity && data.activity.active);
  if (running) detailTimer = setTimeout(() => loadSite(detail.target, true), 10000);
}
async function loadSite(target, background = false) {
  try {
    const response = await fetch(`/api/site?target=${encodeURIComponent(target)}`); const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Site unavailable");
    if (detail.target !== target || detailView.hidden) return;
    const json = JSON.stringify(data);
    if (!background || json !== detail.json) { detail.json = json; renderDetail(data); }
    scheduleDetailRefresh(data);
  } catch (error) {
    if (background) { detailTimer = setTimeout(() => loadSite(target, true), 15000); return; }
    $("#detail-title").textContent = "Site detail unavailable"; $("#detail-subtitle").textContent = error.message;
  }
}
async function openSite(target) {
  clearTimeout(refreshTimer); clearTimeout(detailTimer);
  if (detail.target !== target) Object.assign(detail, { target, data: null, json: "", filter: "all", expanded: new Set(), shotMode: null });
  $("#detail-view").hidden = false; $("#dashboard-view").hidden = true; $("#crumb").hidden = false; $("#crumb span").textContent = target;
  await loadSite(target);
}
// Poll every 15s at rest, every 2s while a run is live (or was just queued) so each stage shows.
let fastUntil = 0;
let runActive = false;
async function refreshDashboard() {
  await loadDashboard();
  if ($("#dashboard-view").hidden) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshDashboard, runActive || Date.now() < fastUntil ? 2000 : 15000);
}
function goHome() { clearTimeout(detailTimer); $("#detail-view").hidden = true; $("#dashboard-view").hidden = false; $("#crumb").hidden = true; clearTimeout(refreshTimer); refreshDashboard(); }

document.querySelectorAll("[data-home]").forEach((button) => button.addEventListener("click", goHome));
document.querySelector(".findings .filter-chips").addEventListener("click", (event) => {
  const chip = event.target.closest("[data-filter]"); if (!chip) return;
  detail.filter = chip.dataset.filter; applyFilter();
});
$("#findings-list").addEventListener("click", (event) => {
  const toggle = event.target.closest(".finding-toggle"); if (!toggle) return;
  const panel = document.getElementById(toggle.getAttribute("aria-controls")); if (!panel) return;
  const id = toggle.closest(".finding").id; const open = panel.hidden;
  panel.hidden = !open; toggle.setAttribute("aria-expanded", String(open));
  if (open) detail.expanded.add(id); else detail.expanded.delete(id);
});
$("#visual-body").addEventListener("click", (event) => {
  const mode = event.target.closest("[data-shot]");
  if (mode && detail.data) {
    detail.shotMode = mode.dataset.shot;
    const viewer = $("#visual-body .viewer");
    const holder = document.createElement("div"); holder.innerHTML = viewerHtml(detail.data.visionAudit, detail.data);
    viewer.replaceWith(holder.firstElementChild);
    const pressed = $(`#visual-body [data-shot="${detail.shotMode}"]`); if (pressed) pressed.focus();
    return;
  }
  const legend = event.target.closest("[data-finding]");
  if (legend) { openFinding(legend.dataset.finding); return; }
  const rec = event.target.closest('a[href^="#rec-"]');
  if (rec) { event.preventDefault(); const card = document.querySelector(rec.getAttribute("href")); if (card) { card.scrollIntoView({ block: "center" }); card.focus({ preventScroll: true }); } }
});
$("#scan-form").addEventListener("submit", async (event) => { event.preventDefault(); const button = event.currentTarget.querySelector("button"); const message = $("#scan-help"); button.disabled = true; message.textContent = "Queuing a real manual scan…"; try { const response = await fetch("/api/scan", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({target: $("#scan-target").value}) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "Scan could not be queued"); message.textContent = "Manual scan queued. The continuous watcher remains active."; fastUntil = Date.now() + 30000; refreshDashboard(); } catch (error) { message.textContent = error.message; } finally { button.disabled = false; } });
goHome();
loadHeartbeat(); setInterval(loadHeartbeat, 1000);
