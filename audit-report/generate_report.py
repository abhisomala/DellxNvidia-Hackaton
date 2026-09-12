#!/usr/bin/env python3
"""Generate the accessibility audit report from a real MongoDB query.

Reads the ``scans``, ``patches`` and ``audit_log`` collections through
``db.mongo_store`` and renders an HTML report plus a JSON sidecar.  There is no
fake-data path: with no matching scan in the database this exits non-zero and
writes nothing, so an empty database can never render a plausible-looking
report.

Usage:
  python3 audit-report/generate_report.py                      # latest scan
  python3 audit-report/generate_report.py --scan-id <objectid>  # a specific scan
"""

from __future__ import annotations

import argparse
import base64
import html
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from db.mongo_store import MongoStore  # noqa: E402

OUT_DIR = REPO_ROOT / "audit-report" / "out"

SEVERITY_ORDER = {"critical": 0, "serious": 1, "moderate": 2, "minor": 3}

# db/live_roundtrip.py writes connectivity-test records under this label.
SYNTHETIC_TARGET_APP = "roundtrip-smoke-test"


GATE_ORDER = ("diff-size", "build", "rescan", "functional", "reviewer", "visual")
VIEWPORT_LABEL = {"desktop": "1280px desktop", "reflow-320": "320px reflow"}
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def finding_source(violation: dict) -> str:
    """Scans stored before the vision stage carry no ``source``: those are DOM (axe) findings."""
    return "vision" if violation.get("source") == "vision" else "axe"


def artifact_data_uri(artifacts_dir, name) -> tuple[str | None, str]:
    """(data URI, shown path) for one vision artifact PNG, or (None, path) when it is missing.

    ``artifacts_dir`` is repo-relative by contract; only PNG files inside it are embedded.
    """
    if not artifacts_dir or not name:
        return None, str(name or "")
    base = Path(str(artifacts_dir))
    base = base if base.is_absolute() else REPO_ROOT / base
    shown = f"{artifacts_dir}/{name}"
    try:
        root = base.resolve(strict=True)
        path = (root / str(name)).resolve(strict=True)
        if not path.is_relative_to(root) or path.suffix.lower() != ".png":
            return None, shown
        data = path.read_bytes()
    except (OSError, RuntimeError, ValueError):
        return None, shown
    if not data.startswith(PNG_SIGNATURE):
        return None, shown
    return "data:image/png;base64," + base64.b64encode(data).decode("ascii"), shown


def render_vision_section(scan: dict, esc) -> str:
    """The "Visual review" section: status, scores, annotated screenshots, findings, design notes."""
    audit = scan.get("vision_audit")
    title = "<h2>Visual review (gemma4:26b vision)</h2>"
    if not isinstance(audit, dict):
        return f'{title}\n  <p class="note">The vision audit did not run for this scan (no <code>vision_audit</code> is recorded), so only DOM findings are reported.</p>'
    status = audit.get("status") or "unknown"
    if status == "running":
        return (f'{title}\n  <p class="note">The vision audit was still running when this report was generated '
                f'(started {esc(audit.get("started_at"))}); its findings are not included.</p>')
    if status == "disabled":
        reason = audit.get("reason") or audit.get("error")
        return (f'{title}\n  <p class="note">The vision audit was turned off for this run'
                f'{f" (<code>{esc(reason)}</code>)" if reason else ""}; no visual checks ran.</p>')
    if status == "unavailable":
        return (f'{title}\n  <div class="banner banner-warn"><strong>The vision audit could not run for this scan.</strong> '
                f'{esc(audit.get("error"))}. Visual checks did not run.</div>')

    artifacts_dir = audit.get("artifacts_dir")
    model = audit.get("model") or {}
    tasks = [t for t in audit.get("tasks") or [] if isinstance(t, dict)]
    cache = audit.get("cache") or {}
    counts = audit.get("counts") or {}
    review = audit.get("design_review") if isinstance(audit.get("design_review"), dict) else None
    annotated = audit.get("annotated") or {}
    vision = [v for v in scan.get("violations", []) if finding_source(v) == "vision"]

    def image(name, alt, css="shot") -> str:
        uri, shown = artifact_data_uri(artifacts_dir, name)
        if uri is None:
            return f'<p class="missing">Image <code>{esc(shown)}</code> is missing on this machine, so it is not embedded.</p>' if name else ""
        return f'<img class="{css}" src="{uri}" alt="{esc(alt)}" />'

    think = [bool(t.get("think")) for t in tasks]
    thinking = "on" if think and all(think) else "partial" if any(think) else "off"
    facts = [
        f"status <b>{esc(status)}</b>",
        f"model <b>{esc(model.get('model'))}</b> ({esc(model.get('base_model'))}, "
        f"{esc(model.get('parameter_size'))} {esc(model.get('quantization'))}, num_ctx {esc(model.get('num_ctx'))})",
        f"thinking <b>{thinking}</b>",
        f"latency <b>{esc(audit.get('latency_s'))} s</b>",
        f"<b>{len(tasks)}</b> model call(s), {sum(1 for t in tasks if t.get('status') != 'ok')} failed",
    ]
    if cache.get("all_cached"):
        cached_at = sorted(str(t.get("cached_at")) for t in tasks if t.get("cached_at"))
        when = cached_at[0] if cached_at else "an earlier run"
        cache_line = (f'<div class="banner banner-warn"><strong>Judgement reused from {esc(when)}:</strong> page pixels '
                      "unchanged, so the model's earlier judgement was reused and no new model call was made.</div>")
        facts.append("cache <b>all calls reused</b>")
    else:
        cache_line = ""
        facts.append(f"cache {'on' if cache.get('enabled') else 'off'}: "
                     f"<b>{esc(cache.get('hits') or 0)} of {esc(cache.get('calls') or len(tasks))}</b> calls reused")
    partial = (f'<div class="banner banner-warn"><strong>Partial result.</strong> {esc(audit.get("error"))}. '
               "Findings below come only from the model calls that finished.</div>") if status == "partial" else ""

    scores_html = ""
    summary_html = ""
    rec_rows = ""
    if review:
        scores = review.get("scores") or {}
        scores_html = '<div class="cards">' + "".join(
            f'<div class="card"><b>{esc(scores.get(key))}<small>/10</small></b><span>{label}</span></div>'
            for key, label in (("overall", "overall design"), ("typography", "typography"), ("color", "color"),
                               ("spacing", "spacing"), ("hierarchy", "hierarchy"))
        ) + '</div>\n  <p class="note">Design scores are the model\'s judgement with an accessibility lens (1-10), not a WCAG pass/fail result.</p>'
        strengths = "".join(f"<li>{esc(s)}</li>" for s in review.get("strengths") or [])
        summary_html = (f"<h3>Design summary</h3>\n  <p>{esc(review.get('summary'))}</p>"
                        + (f"\n  <h3>Strengths</h3>\n  <ul>{strengths}</ul>" if strengths else ""))
        rec_rows = "\n".join(
            f"""      <tr>
        <td>{esc(item.get('number') or index)}</td>
        <td>{esc(item.get('area'))}</td>
        <td class="nowrap"><span class="prio prio-{esc(item.get('priority'))}">{esc(item.get('priority'))}</span></td>
        <td>{esc(item.get('issue'))}</td>
        <td>{esc(item.get('recommendation'))}</td>
        <td><code>{esc(item.get('css_suggestion'))}</code></td>
        <td>{esc(item.get('accessibility_benefit'))}</td>
        <td><code>{esc(item.get('selector'))}</code></td>
      </tr>"""
            for index, item in enumerate(review.get("improvements") or [], start=1)
            if isinstance(item, dict)
        )

    finding_rows = "\n".join(
        f"""      <tr>
        <td>{esc((v.get('vision') or {}).get('number') or number)}</td>
        <td class="nowrap"><span class="sev sev-{esc(v.get('severity'))}">{esc(v.get('severity'))}</span></td>
        <td class="nowrap"><code>{esc(v.get('rule_id'))}</code><br /><small>{esc(VIEWPORT_LABEL.get((v.get('vision') or {}).get('viewport'), (v.get('vision') or {}).get('viewport')))}</small></td>
        <td class="nowrap">{confidence_text(v)}<br /><small>{esc((v.get('vision') or {}).get('method'))}</small></td>
        <td><strong>{esc(v.get('description'))}</strong><br />{esc(v.get('failure_summary'))}
            <br /><em>Recommendation:</em> {esc(v.get('help'))}
            {f'<br /><a href="{esc(v.get("help_url"))}">{esc(v.get("help_url"))}</a>' if v.get('help_url') else ''}</td>
        <td>{image((v.get('vision') or {}).get('evidence_image'), f"Evidence crop for {v.get('description')} ({v.get('selector')})", 'crop')}</td>
      </tr>"""
        for number, v in enumerate(vision, start=1)
    )

    dropped = [("deduplicated", d) for d in audit.get("deduplicated") or [] if isinstance(d, dict)] + [
        ("suppressed", s) for s in audit.get("suppressed") or [] if isinstance(s, dict)]
    dropped_html = "".join(
        f"<li>{kind}: {esc(d.get('category'))} <code>{esc(d.get('selector'))}</code> - {esc(d.get('reason'))}</li>"
        for kind, d in dropped
    )
    task_rows = "\n".join(
        f"""      <tr><td>{esc(t.get('name'))}</td><td>{esc(t.get('images'))}</td><td>{'on' if t.get('think') else 'off'}</td>
        <td>{esc((t.get('stats') or {}).get('latency_s'))}</td><td>{esc((t.get('stats') or {}).get('output_tokens'))}</td>
        <td>{esc(t.get('status'))}{f" (reused from {esc(t.get('cached_at'))})" if t.get('cached') else ''}{f": {esc(t.get('error'))}" if t.get('error') else ''}</td></tr>"""
        for t in tasks
    )
    by_viewport = {}
    for v in vision:
        key = (v.get("vision") or {}).get("viewport")
        by_viewport[key] = by_viewport.get(key, 0) + 1

    return f"""{title}
  {partial}{cache_line}
  <p class="facts">{' &middot; '.join(facts)}</p>
  {scores_html}
  {summary_html}

  <h3>Annotated screenshot: vision findings at 1280px desktop ({by_viewport.get('desktop', 0)})</h3>
  <p class="note">Numbers on the screenshot match the # column of the vision findings table below.</p>
  <figure>{image(annotated.get('desktop'), 'Annotated 1280px desktop screenshot with numbered vision findings') or '<p class="missing">No annotated desktop screenshot was recorded.</p>'}</figure>
  <details><summary>Annotated 320px reflow screenshot ({by_viewport.get('reflow-320', 0)} finding(s))</summary>
  <figure class="narrow">{image(annotated.get('reflow-320'), 'Annotated 320px-wide reflow screenshot with numbered vision findings') or '<p class="missing">No annotated reflow screenshot was recorded.</p>'}</figure></details>

  <h3>Vision findings ({len(vision)})</h3>
  <div class="wrap"><table>
    <thead><tr><th>#</th><th>Severity</th><th>Rule / viewport</th><th>Confidence / method</th><th>Finding, evidence and recommendation</th><th>Evidence crop</th></tr></thead>
    <tbody>
{finding_rows or '      <tr><td colspan="6">none</td></tr>'}
    </tbody>
  </table></div>
  <p class="note">{esc(counts.get('deduplicated', 0))} deduplicated against DOM findings &middot; {esc(counts.get('suppressed', 0))} suppressed (low confidence or judged by another pass). Vision findings are recorded for human review and are not auto-patched.</p>
  {f'<ul class="note">{dropped_html}</ul>' if dropped_html else ''}

  <h3>Design recommendations</h3>
  <figure>{image(annotated.get('design'), 'Desktop screenshot annotated with numbered design recommendations') if review else ''}</figure>
  <div class="wrap"><table>
    <thead><tr><th>#</th><th>Area</th><th>Priority</th><th>Issue</th><th>Recommendation</th><th>CSS suggestion</th><th>Accessibility benefit</th><th>Selector</th></tr></thead>
    <tbody>
{rec_rows or '      <tr><td colspan="8">no design review recorded</td></tr>'}
    </tbody>
  </table></div>

  <details><summary>Model calls ({len(tasks)})</summary>
  <div class="wrap"><table>
    <thead><tr><th>Call</th><th>Images</th><th>Thinking</th><th>Latency (s)</th><th>Output tokens</th><th>Result</th></tr></thead>
    <tbody>
{task_rows or '      <tr><td colspan="6">none</td></tr>'}
    </tbody>
  </table></div></details>"""


def confidence_text(violation: dict) -> str:
    confidence = violation.get("confidence")
    if finding_source(violation) != "vision":
        return "deterministic"
    if isinstance(confidence, (int, float)) and not isinstance(confidence, bool):
        return f"{round(confidence * 100)}%"
    return "unknown"


def jsonable(value):
    """Make BSON/datetime values renderable."""
    if isinstance(value, dict):
        return {k: jsonable(v) for k, v in value.items()}
    if isinstance(value, list):
        return [jsonable(v) for v in value]
    if isinstance(value, datetime):
        return value.isoformat()
    if hasattr(value, "binary") or type(value).__name__ == "ObjectId":
        return str(value)
    return value


def pick_default_scan(
    store: MongoStore, *, any_scan: bool = False, target_app: str | None = None
) -> dict:
    """Choose the newest scan a reader would mean by "the latest scan".

    The ``scans`` collection is shared, and three kinds of document in it would
    each render a truthful-looking report about the wrong thing:

    * a **verification** scan - a rescan of an already-patched copy, so it
      legitimately shows zero violations;
    * a **synthetic** connectivity-test scan from ``db/live_roundtrip.py``;
    * a **bridge stub** - Path 2's ``record_to_mongo.py`` inserts a minimal
      scan (``target_app: "unknown"``) when its report carries no ``scan_id``.

    Rather than blacklisting each, this requires the positive signal that a
    scan came from a real Path 1 report: ``scanner_metadata``, which only
    ``MongoStore.insert_axe_scan`` writes.  Verification scans have it too, so
    those are excluded via the patches that point at them.  ``--scan-id``
    reports on any scan regardless, and ``--any-scan`` drops both filters.
    ``target_app`` narrows the search to one monitored site.

    Raises ``LookupError`` when nothing qualifies, so an in-process caller
    (the dashboard) can render "no report yet" instead of exiting.
    """
    verification_ids = {
        patch["verification_scan_id"]
        for patch in store.patches.find(
            {"verification_scan_id": {"$ne": None}}, {"verification_scan_id": 1}
        )
    }
    skipped: list[str] = []
    query = {"target_app": target_app} if target_app else None
    for scan in store.find_scans(query):  # newest first
        if not any_scan:
            if scan["_id"] in verification_ids:
                skipped.append(f"{scan['_id']} (verification rescan)")
                continue
            if not scan.get("scanner_metadata"):
                why = (
                    "synthetic connectivity test"
                    if scan.get("target_app") == SYNTHETIC_TARGET_APP
                    else "not from a Path 1 scan report"
                )
                skipped.append(f"{scan['_id']} ({why})")
                continue
        if skipped:
            print(f"skipped {len(skipped)} newer scan(s): {', '.join(skipped)}")
        return scan

    detail = f" (skipped: {', '.join(skipped)})" if skipped else ""
    scope = f" for {target_app}" if target_app else ""
    raise LookupError(
        f"no reportable scan{scope} in {store.database.name}.scans{detail} - "
        "run pipeline/run_pipeline.py first, or pass --scan-id / --any-scan"
    )


def collect(
    store: MongoStore,
    scan_id: str | None,
    *,
    any_scan: bool = False,
    target_app: str | None = None,
) -> dict:
    """Query the real records for one scan and everything cross-referencing it."""
    if scan_id:
        scan = store.get_scan(scan_id)
        if scan is None:
            raise LookupError(f"no scan with _id {scan_id} in {store.database.name}.scans")
    else:
        scan = pick_default_scan(store, any_scan=any_scan, target_app=target_app)

    patches = store.find_patches({"scan_id": scan["_id"]})
    # audit_log stores the scan/patch references as strings.
    patch_ids = {str(p["_id"]) for p in patches}
    events = [
        event
        for event in store.find_audit_events()
        if event.get("details", {}).get("scan_id") == str(scan["_id"])
        or event.get("details", {}).get("patch_id") in patch_ids
    ]
    verifications = {}
    for patch in patches:
        vs_id = patch.get("verification_scan_id")
        if vs_id is not None:
            verifications[str(patch["_id"])] = store.get_scan(vs_id)
    return {"scan": scan, "patches": patches, "events": events, "verifications": verifications}


def render_html(data: dict, database: str) -> str:
    scan = data["scan"]
    patches = data["patches"]
    events = data["events"]
    verifications = data["verifications"]

    violations = sorted(
        scan["violations"], key=lambda v: SEVERITY_ORDER.get(v.get("severity"), 4)
    )
    meta = scan.get("scanner_metadata") or {}
    simulated = any("simulated" in (p.get("model_used") or "") for p in patches)

    def esc(value) -> str:
        return html.escape(str(value if value is not None else "-"))

    rows = "\n".join(
        f"""      <tr>
        <td class="nowrap"><span class="sev sev-{esc(v.get('severity'))}">{esc(v.get('severity'))}</span></td>
        <td class="nowrap"><span class="src src-{finding_source(v)}">{'vision' if finding_source(v) == 'vision' else 'axe'}</span></td>
        <td><code>{esc(v.get('rule_id'))}</code></td>
        <td><code>{esc(v.get('selector'))}</code></td>
        <td>{esc(v.get('source_file'))}</td>
        <td class="nowrap">{confidence_text(v)}</td>
        <td>{esc(v.get('description'))}</td>
      </tr>"""
        for v in violations
    )
    vision_count = sum(1 for v in scan["violations"] if finding_source(v) == "vision")
    dom_count = len(scan["violations"]) - vision_count

    gates_by_patch = {}
    for event in events:
        details = event.get("details", {})
        if event.get("event_type") == "verified" and details.get("patch_id") and isinstance(details.get("gate_results"), dict):
            gates_by_patch.setdefault(str(details["patch_id"]), details["gate_results"])

    def gates_text(patch) -> str:
        results = gates_by_patch.get(str(patch.get("_id")))
        if not results:
            return "-"
        names = [n for n in GATE_ORDER if n in results] + sorted(set(results) - set(GATE_ORDER))
        return "<br />".join(f"{esc(n)}: {esc(results[n])}" for n in names)

    patch_rows = "\n".join(
        f"""      <tr>
        <td class="nowrap"><code>{esc(p.get('violation_rule_id'))}</code></td>
        <td>{esc(p.get('source_file'))}</td>
        <td><code>{esc(p.get('original_snippet'))}</code></td>
        <td><code>{esc(p.get('patched_snippet'))}</code></td>
        <td class="nowrap">{'verified' if p.get('verified') else 'not verified'}</td>
        <td class="nowrap"><small>{gates_text(p)}</small></td>
        <td>{esc(p.get('verification_scan_id'))}</td>
        <td>{esc(p.get('model_used'))}</td>
      </tr>"""
        for p in patches
    )

    event_rows = "\n".join(
        f"""      <tr>
        <td class="nowrap">{esc(e.get('event_type'))}</td>
        <td class="nowrap">{esc(e.get('timestamp'))}</td>
        <td><code>{esc(json.dumps(jsonable(e.get('details', {}))))}</code></td>
      </tr>"""
        for e in events
    )

    verification_note = ""
    for patch_id, vscan in verifications.items():
        if vscan is None:
            continue
        remaining = [
            v for v in vscan["violations"]
            if (v.get("rule_id"), v.get("selector"))
            in {(p.get("violation_rule_id"), None) for p in patches}
        ]
        verification_note += (
            f"<p>Patch <code>{esc(patch_id)}</code> was verified by re-scanning "
            f"<code>{esc(vscan['target_app'])}</code> (scan <code>{esc(vscan['_id'])}</code>), "
            f"which reported {len(vscan['violations'])} failing element(s).</p>"
        )

    if scan.get("target_app") == SYNTHETIC_TARGET_APP:
        banner = (
            '<div class="banner banner-warn"><strong>This is a synthetic connectivity-test '
            "scan</strong> written by <code>db/live_roundtrip.py</code>, not a real "
            "accessibility scan of the demo app.</div>"
        )
    else:
        banner = (
            '<div class="banner banner-warn"><strong>Patch content is simulated.</strong> '
            "Path 2's remediation harness produced no output in this checkout, so the patch "
            "shown below was generated by <code>pipeline/patch_stub.py</code>. The scan, the "
            "verification rescan and every database record are real.</div>"
            if simulated
            else '<div class="banner banner-ok">All records in this report are real end to end.</div>'
        )

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Accessibility audit report</title>
<style>
  :root {{ color-scheme: light; --ink:#15202b; --muted:#5b6875; --line:#e3e8ee; --bg:#f7f9fb; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; padding:32px 20px; background:var(--bg); color:var(--ink);
         font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }}
  main {{ max-width:1100px; margin:0 auto; }}
  h1 {{ font-size:26px; margin:0 0 4px; }}
  h2 {{ font-size:17px; margin:32px 0 10px; }}
  .sub {{ color:var(--muted); margin:0 0 20px; }}
  .banner {{ padding:12px 14px; border-radius:8px; margin:0 0 22px; border:1px solid var(--line); }}
  .banner-warn {{ background:#fff8e5; border-color:#f0d999; }}
  .banner-ok {{ background:#eaf7ee; border-color:#a9d8b8; }}
  .cards {{ display:flex; flex-wrap:wrap; gap:12px; margin:0 0 8px; }}
  .card {{ flex:1 1 170px; background:#fff; border:1px solid var(--line); border-radius:8px; padding:12px 14px; }}
  .card b {{ display:block; font-size:22px; }}
  .card span {{ color:var(--muted); font-size:13px; }}
  table {{ width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--line);
           border-radius:8px; overflow:hidden; }}
  th, td {{ text-align:left; padding:9px 11px; border-bottom:1px solid var(--line); vertical-align:top;
            font-size:13.5px; word-break:break-word; }}
  th {{ background:#eef2f6; font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }}
  tr:last-child td {{ border-bottom:none; }}
  code {{ font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; }}
  .sev {{ padding:2px 8px; border-radius:20px; font-size:12px; font-weight:600; }}
  .sev-critical {{ background:#fde8e8; color:#9b1c1c; }}
  .sev-serious {{ background:#feecdc; color:#9c4221; }}
  .sev-moderate {{ background:#fdf6b2; color:#7d6608; }}
  .sev-minor {{ background:#e1effe; color:#1e429f; }}
  .wrap {{ overflow-x:auto; }}
  .wrap table {{ min-width:720px; }}
  th {{ word-break:normal; white-space:nowrap; }}
  td.nowrap {{ word-break:normal; white-space:nowrap; }}
  h3 {{ font-size:15px; margin:22px 0 8px; }}
  .note {{ color:var(--muted); font-size:13.5px; }}
  .facts {{ background:#fff; border:1px solid var(--line); border-radius:8px; padding:10px 14px; font-size:13.5px; }}
  .card small {{ font-size:13px; color:var(--muted); font-weight:400; }}
  .src {{ padding:2px 7px; border-radius:4px; font-size:12px; font-weight:600; border:1px solid var(--line); background:#fff; }}
  .src-vision {{ background:#eef0ff; border-color:#c7cdfa; color:#3730a3; }}
  .prio {{ font-size:12px; font-weight:600; }}
  .prio-high {{ color:#9c4221; }}
  figure {{ margin:10px 0; }}
  figure img.shot {{ display:block; max-width:min(100%, 820px); height:auto; border:1px solid var(--line); border-radius:6px; background:#fff; }}
  figure.narrow img.shot {{ max-width:320px; }}
  img.crop {{ display:block; max-width:200px; height:auto; border:1px solid var(--line); border-radius:4px; }}
  .missing {{ color:#9c4221; font-size:13px; }}
  details {{ margin:12px 0; }}
  summary {{ cursor:pointer; font-weight:600; font-size:14px; }}
  footer {{ color:var(--muted); font-size:12.5px; margin-top:28px; }}
</style>
</head>
<body>
<main>
  <h1>Accessibility audit report</h1>
  <p class="sub">{esc(scan['target_app'])} &middot; scan <code>{esc(scan['_id'])}</code> &middot;
     {esc(scan['timestamp'])}</p>
  {banner}

  <div class="cards">
    <div class="card"><b>{len(scan['violations'])}</b><span>findings ({dom_count} DOM &middot; {vision_count} vision)</span></div>
    <div class="card"><b>{len(patches)}</b><span>patches recorded</span></div>
    <div class="card"><b>{sum(1 for p in patches if p.get('verified'))}</b><span>verified</span></div>
    <div class="card"><b>{len(events)}</b><span>audit events</span></div>
    <div class="card"><b>{esc(meta.get('engine_name'))} {esc(meta.get('engine_version'))}</b><span>scan engine</span></div>
  </div>

  <h2>Violations found by the scanner</h2>
  <div class="wrap"><table>
    <thead><tr><th>Severity</th><th>Source</th><th>Rule</th><th>Selector</th><th>Source file</th><th>Confidence</th><th>Description</th></tr></thead>
    <tbody>
{rows or '      <tr><td colspan="7">none</td></tr>'}
    </tbody>
  </table></div>

  <h2>Patches</h2>
  <div class="wrap"><table>
    <thead><tr><th>Rule</th><th>Source file</th><th>Before</th><th>After</th><th>State</th>
               <th>Gates</th><th>Verification scan</th><th>Model</th></tr></thead>
    <tbody>
{patch_rows or '      <tr><td colspan="8">none</td></tr>'}
    </tbody>
  </table></div>
  {verification_note}

  {render_vision_section(scan, esc)}

  <h2>Audit log</h2>
  <div class="wrap"><table>
    <thead><tr><th>Event</th><th>Timestamp</th><th>Details</th></tr></thead>
    <tbody>
{event_rows or '      <tr><td colspan="3">none</td></tr>'}
    </tbody>
  </table></div>

  <footer>
    Generated {datetime.now(timezone.utc).isoformat()} by a live query against
    <code>{esc(database)}</code> &mdash; collections <code>scans</code>,
    <code>patches</code>, <code>audit_log</code>.
  </footer>
</main>
</body>
</html>
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--scan-id",
        help="scans._id to report on (default: the newest scan that is neither a "
        "verification rescan nor a synthetic connectivity test)",
    )
    parser.add_argument("--out-dir", default=str(OUT_DIR))
    parser.add_argument("--target-app", help="report on the newest scan of one site")
    parser.add_argument(
        "--any-scan",
        action="store_true",
        help="report on the newest scan of any kind, including verification "
        "rescans, synthetic connectivity tests and Path 2 bridge stubs",
    )
    args = parser.parse_args()

    store = MongoStore(server_selection_timeout_ms=3000)
    try:
        store.ping()
        data = collect(
            store, args.scan_id, any_scan=args.any_scan, target_app=args.target_app
        )
        database = store.database.name
    except LookupError as exc:
        raise SystemExit(str(exc)) from exc
    finally:
        store.close()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    html_path = out_dir / "audit-report.html"
    json_path = out_dir / "audit-report.json"
    html_path.write_text(render_html(data, database))
    json_path.write_text(json.dumps(jsonable(data), indent=2))

    scan = data["scan"]
    print(
        f"REPORT GENERATED from a live query on {database}: "
        f"scan {scan['_id']} ({scan['target_app']}), "
        f"{len(scan['violations'])} violation(s), {len(data['patches'])} patch(es), "
        f"{len(data['events'])} audit event(s)"
    )
    for path in (html_path, json_path):
        # An --out-dir outside the repository has no relative form.
        try:
            shown = path.relative_to(REPO_ROOT)
        except ValueError:
            shown = path
        print(f"  {shown}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
