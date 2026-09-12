const $ = (selector) => document.querySelector(selector);
const dashboardView = $("#dashboard-view");
const detailView = $("#detail-view");
let refreshTimer;

function time(value) {
  if (!value) return "No recorded scan";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
function elapsed(value) {
  if (!value) return "Idle";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`;
}
function escapeHtml(value) { const node = document.createElement("span"); node.textContent = value ?? ""; return node.innerHTML; }
function activityCopy(activity) {
  if (!activity.active) return "No recent scan event is in progress. GuardRail is standing by.";
  const labels = { scan: "Scanning target", locate: "Locating findings", patch: "Applying code-level remediation", verify: "Verifying remediation", record: "Recording results" };
  return `${labels[activity.stage] || "Processing local audit activity"}. The next event will advance the recorded pipeline.`;
}
function drawActivity(activity) {
  const order = ["scan", "locate", "patch", "verify", "record"];
  const current = order.indexOf(activity.stage);
  $("#activity-title").textContent = activity.active ? activityCopy(activity).split(".")[0] : "Awaiting a local scan";
  $("#activity-elapsed").textContent = activity.active ? `latest event ${elapsed(activity.timestamp)}` : "Idle";
  $("#activity-copy").textContent = activityCopy(activity);
  document.querySelectorAll(".pipeline li").forEach((item, index) => {
    item.classList.toggle("done", activity.active && index < current);
    item.classList.toggle("active", activity.active && index === current);
  });
}
function showRegistryState(message, error = false) {
  const state = $("#registry-state"); state.textContent = message; state.hidden = false; state.classList.toggle("error", error);
}
function renderSites(sites) {
  const body = $("#registry-body"); body.innerHTML = ""; $("#registry-state").hidden = true;
  $("#registry-count").textContent = `${sites.length} ${sites.length === 1 ? "target" : "targets"}`;
  if (!sites.length) { showRegistryState("No scan records have been stored yet. Start a scan to register a target."); return; }
  sites.forEach((site) => {
    const row = document.createElement("tr");
    const trigger = site.triggerSource ? `<span class="trigger-tag">${escapeHtml(site.triggerSource)}</span>` : "<span class=\"trigger-tag\">unknown</span>";
    row.innerHTML = `<td><button class="site-button" type="button">${escapeHtml(site.targetApp)}</button></td><td class="mono">${escapeHtml(time(site.lastScan))}</td><td class="mono">${site.violationCount}</td><td><span class="status ${site.status.replace(" ", "-")}">${escapeHtml(site.status)}</span></td><td>${trigger}</td>`;
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
    $("#refresh-note").textContent = data.isFallback ? "Local demo scan · MongoDB unavailable" : "Live read from MongoDB · refreshes every 15s";
    drawActivity(data.activity); renderSites(data.sites);
    if (data.isFallback) showRegistryState("Showing the most recent real local axe scan of demo/index.html. It is not a persisted MongoDB record.");
  } catch (error) {
    $("#refresh-note").textContent = "Local store unavailable";
    drawActivity({ active: false }); renderSites([]);
    showRegistryState("MongoDB is unavailable. Check MONGODB_URI and MONGODB_DATABASE, then reload. No data is shown.", true);
  }
}
function renderTrend(history) {
  const chart = $("#trend-chart"); chart.innerHTML = "";
  if (history.length < 2) { chart.innerHTML = '<p class="chart-note">Not enough history yet. A trend appears after a second scan.</p>'; return; }
  const max = Math.max(...history.map((point) => point.violationCount), 1);
  history.slice(-12).forEach((point) => { const bar = document.createElement("div"); bar.className = "bar"; bar.innerHTML = `<b>${point.violationCount}</b><i style="height:${Math.max(3, point.violationCount / max * 100)}%"></i><span title="${escapeHtml(time(point.timestamp))}">${new Date(point.timestamp).toLocaleDateString(undefined, { month:"short", day:"numeric" })}</span>`; chart.appendChild(bar); });
}
function renderDetail(data) {
  $("#detail-title").textContent = data.targetApp;
  $("#detail-subtitle").textContent = `Latest scan: ${time(data.latestScan)}.`;
  $("#findings-count").textContent = `${data.violations.length} ${data.violations.length === 1 ? "finding" : "findings"}`;
  $("#report-link").href = `/api/report?target=${encodeURIComponent(data.targetApp)}`;
  const findings = $("#findings-list"); findings.innerHTML = data.violations.length ? "" : '<p class="empty-finding">This latest scan has no current violations.</p>';
  data.violations.forEach((finding) => { const item = document.createElement("article"); item.className = "finding"; const diff = finding.originalSnippet !== null && finding.patchedSnippet !== null ? `<div class="diff" aria-label="Recorded patch diff"><pre><span class="diff-label">Before</span>${escapeHtml(finding.originalSnippet)}</pre><pre><span class="diff-label">After</span>${escapeHtml(finding.patchedSnippet)}</pre></div>` : ""; item.innerHTML = `<div><div class="finding-rule">${escapeHtml(finding.ruleId)}</div><div class="finding-selector">${escapeHtml(finding.sourceFile)}</div></div><div class="finding-selector" title="${escapeHtml(finding.selector)}">${escapeHtml(finding.selector)}</div><span class="severity">${escapeHtml(finding.severity)}</span><span class="fix-status ${finding.fixStatus}">${finding.fixStatus}</span>${diff}`; findings.appendChild(item); });
  renderTrend(data.history);
  const access = $("#access-list"); access.innerHTML = data.accessPoints.length ? data.accessPoints.map((point) => `<li>${escapeHtml(point)}</li>`).join("") : "<li>No source file or URL has been recorded yet.</li>";
}
async function openSite(target) {
  clearInterval(refreshTimer); $("#detail-view").hidden = false; $("#dashboard-view").hidden = true; $("#crumb").hidden = false; $("#crumb span").textContent = target;
  try { const response = await fetch(`/api/site?target=${encodeURIComponent(target)}`); const data = await response.json(); if (!response.ok) throw new Error(data.error || "Site unavailable"); renderDetail(data); } catch (error) { $("#detail-title").textContent = "Site detail unavailable"; $("#detail-subtitle").textContent = error.message; }
}
function goHome() { $("#detail-view").hidden = true; $("#dashboard-view").hidden = false; $("#crumb").hidden = true; loadDashboard(); refreshTimer = setInterval(loadDashboard, 15000); }
document.querySelectorAll("[data-home]").forEach((button) => button.addEventListener("click", goHome));
$("#scan-form").addEventListener("submit", async (event) => { event.preventDefault(); const button = event.currentTarget.querySelector("button"); const message = $("#scan-help"); button.disabled = true; message.textContent = "Queuing a real manual scan…"; try { const response = await fetch("/api/scan", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({target: $("#scan-target").value}) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "Scan could not be queued"); message.textContent = "Manual scan queued. The continuous watcher remains active."; loadDashboard(); } catch (error) { message.textContent = error.message; } finally { button.disabled = false; } });
goHome();
loadHeartbeat(); setInterval(loadHeartbeat, 1000);
