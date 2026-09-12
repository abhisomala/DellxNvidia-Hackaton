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


def pick_default_scan(store: MongoStore, *, any_scan: bool = False) -> dict:
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
    """
    verification_ids = {
        patch["verification_scan_id"]
        for patch in store.patches.find(
            {"verification_scan_id": {"$ne": None}}, {"verification_scan_id": 1}
        )
    }
    skipped: list[str] = []
    for scan in store.find_scans():  # newest first
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
    raise SystemExit(
        f"no reportable scan in {store.database.name}.scans{detail} - "
        "run pipeline/run_pipeline.py first, or pass --scan-id / --any-scan"
    )


def collect(store: MongoStore, scan_id: str | None, *, any_scan: bool = False) -> dict:
    """Query the real records for one scan and everything cross-referencing it."""
    if scan_id:
        scan = store.get_scan(scan_id)
        if scan is None:
            raise SystemExit(f"no scan with _id {scan_id} in {store.database.name}.scans")
    else:
        scan = pick_default_scan(store, any_scan=any_scan)

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
        <td><span class="sev sev-{esc(v.get('severity'))}">{esc(v.get('severity'))}</span></td>
        <td><code>{esc(v.get('rule_id'))}</code></td>
        <td><code>{esc(v.get('selector'))}</code></td>
        <td>{esc(v.get('source_file'))}</td>
        <td>{esc(v.get('description'))}</td>
      </tr>"""
        for v in violations
    )

    patch_rows = "\n".join(
        f"""      <tr>
        <td><code>{esc(p.get('violation_rule_id'))}</code></td>
        <td>{esc(p.get('source_file'))}</td>
        <td><code>{esc(p.get('original_snippet'))}</code></td>
        <td><code>{esc(p.get('patched_snippet'))}</code></td>
        <td>{'verified' if p.get('verified') else 'not verified'}</td>
        <td>{esc(p.get('verification_scan_id'))}</td>
        <td>{esc(p.get('model_used'))}</td>
      </tr>"""
        for p in patches
    )

    event_rows = "\n".join(
        f"""      <tr>
        <td>{esc(e.get('event_type'))}</td>
        <td>{esc(e.get('timestamp'))}</td>
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
    <div class="card"><b>{len(scan['violations'])}</b><span>failing elements</span></div>
    <div class="card"><b>{len(patches)}</b><span>patches recorded</span></div>
    <div class="card"><b>{sum(1 for p in patches if p.get('verified'))}</b><span>verified</span></div>
    <div class="card"><b>{len(events)}</b><span>audit events</span></div>
    <div class="card"><b>{esc(meta.get('engine_name'))} {esc(meta.get('engine_version'))}</b><span>scan engine</span></div>
  </div>

  <h2>Violations found by the scanner</h2>
  <div class="wrap"><table>
    <thead><tr><th>Severity</th><th>Rule</th><th>Selector</th><th>Source file</th><th>Description</th></tr></thead>
    <tbody>
{rows or '      <tr><td colspan="5">none</td></tr>'}
    </tbody>
  </table></div>

  <h2>Patches</h2>
  <div class="wrap"><table>
    <thead><tr><th>Rule</th><th>Source file</th><th>Before</th><th>After</th><th>State</th>
               <th>Verification scan</th><th>Model</th></tr></thead>
    <tbody>
{patch_rows or '      <tr><td colspan="7">none</td></tr>'}
    </tbody>
  </table></div>
  {verification_note}

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
        data = collect(store, args.scan_id, any_scan=args.any_scan)
        database = store.database.name
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
