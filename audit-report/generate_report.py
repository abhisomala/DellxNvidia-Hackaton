#!/usr/bin/env python3
"""Generate a presentation-ready accessibility compliance audit report.

The reporting code consumes plain mappings shaped like the ``scans``,
``patches``, and ``audit_log`` documents in db/mongo_store.py.  Replace only
``load_audit_data`` when MongoDB becomes available; the rendering pipeline
does not depend on the sample fixture.
"""

from __future__ import annotations

import argparse
import html
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence


REPORT_DIR = Path(__file__).resolve().parent
DEFAULT_OUTPUT = REPORT_DIR / "compliance-audit-report.html"

WCAG_BY_RULE = {
    "button-name": "WCAG 2.2 — 4.1.2 Name, Role, Value (A)",
    "label": "WCAG 2.2 — 1.3.1 Info and Relationships (A)",
    "modal-focus-management": "WCAG 2.2 — 2.4.3 Focus Order (A)",
}


def load_audit_data(target_app: str | None = None) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    """Return the report inputs.

    With ``target_app``, load the latest real scan and its linked records from
    MongoDB.  The fixture remains available for a standalone visual example.
    """
    if target_app is not None:
        sys.path.insert(0, str(REPORT_DIR.parent))
        from db.mongo_store import MongoStore

        store = MongoStore(server_selection_timeout_ms=2500)
        try:
            store.ping()
            scans = store.find_scans({"target_app": target_app}, limit=1)
            if not scans:
                raise LookupError(f"No scans found for target_app: {target_app}")
            scan = scans[0]
            patches = store.find_patches({"scan_id": scan["_id"]})
            audit_log = store.find_audit_events({"details.scan_id": scan["_id"]})
            return scan, patches, audit_log
        finally:
            store.close()

    scan_id = "66b3a4c154d9ba6c64f3a001"
    verification_scan_id = "66b3a4c154d9ba6c64f3a002"
    scan = {
        "_id": scan_id,
        "timestamp": datetime(2026, 9, 12, 14, 5, tzinfo=timezone.utc),
        "target_app": "demo/index.html — Harbor & Pine",
        "violations": [
            {
                "rule_id": "button-name",
                "selector": ".bag-button",
                "severity": "critical",
                "description": "The shopping-bag button has no accessible name, so assistive technology cannot identify its purpose.",
                "source_file": "demo/index.html",
            },
            {
                "rule_id": "label",
                "selector": "#customer-email",
                "severity": "serious",
                "description": "The email input has a placeholder but no programmatic label.",
                "source_file": "demo/index.html",
            },
            {
                "rule_id": "modal-focus-management",
                "selector": "#hours-modal",
                "severity": "serious",
                "description": "The modal suppresses every Tab keypress and never restores focus to the control that opened it.",
                "source_file": "demo/script.js",
            },
        ],
    }
    patches = [
        {
            "_id": "66b3a4c154d9ba6c64f3b001",
            "scan_id": scan_id,
            "violation_rule_id": "button-name",
            "source_file": "demo/index.html",
            "original_snippet": '<button class="bag-button" type="button" data-open-modal></button>',
            "patched_snippet": '<button class="bag-button" type="button" data-open-modal aria-label="Open shop hours"></button>',
            "model_used": "demo remediation",
            "applied_at": datetime(2026, 9, 12, 14, 8, tzinfo=timezone.utc),
            "verified": True,
            "verification_scan_id": verification_scan_id,
        },
        {
            "_id": "66b3a4c154d9ba6c64f3b002",
            "scan_id": scan_id,
            "violation_rule_id": "label",
            "source_file": "demo/index.html",
            "original_snippet": '<input id="customer-email" name="email" type="email" placeholder="Email address" autocomplete="email" required />',
            "patched_snippet": '<label for="customer-email">Email address</label>\n<input id="customer-email" name="email" type="email" autocomplete="email" required />',
            "model_used": "demo remediation",
            "applied_at": datetime(2026, 9, 12, 14, 9, tzinfo=timezone.utc),
            "verified": True,
            "verification_scan_id": verification_scan_id,
        },
        {
            "_id": "66b3a4c154d9ba6c64f3b003",
            "scan_id": scan_id,
            "violation_rule_id": "modal-focus-management",
            "source_file": "demo/script.js",
            "original_snippet": "modal.addEventListener('keydown', (event) => {\n  if (event.key === 'Tab') {\n    event.preventDefault();\n    closeButton.focus();\n  }\n});",
            "patched_snippet": "function closeModal() {\n  modal.hidden = true;\n  lastFocusedElement?.focus();\n}\nconst focusable = modal.querySelectorAll('button, a[href]');\nif (event.key === 'Tab' && document.activeElement === focusable.at(-1)) {\n  event.preventDefault();\n  focusable[0].focus();\n}\nif (event.key === 'Escape') closeModal();",
            "model_used": "demo remediation",
            "applied_at": datetime(2026, 9, 12, 14, 11, tzinfo=timezone.utc),
            "verified": True,
            "verification_scan_id": verification_scan_id,
        },
    ]
    audit_log = [
        {"_id": "66b3a4c154d9ba6c64f3c001", "event_type": "scan_run", "timestamp": scan["timestamp"], "details": {"scan_id": scan_id}},
        {"_id": "66b3a4c154d9ba6c64f3c002", "event_type": "verified", "timestamp": datetime(2026, 9, 12, 14, 13, tzinfo=timezone.utc), "details": {"scan_id": verification_scan_id}},
    ]
    return scan, patches, audit_log


def format_time(value: Any) -> str:
    """Format either PyMongo datetimes or ISO strings consistently for the report."""
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).strftime("%b %-d, %Y · %H:%M UTC")
    return str(value)


def code_block(source: str, label: str) -> str:
    return (
        f'<div class="code-panel"><div class="code-label">{label}</div>'
        f'<pre><code>{html.escape(source)}</code></pre></div>'
    )


def status_badge(verified: bool) -> str:
    label = "Verified" if verified else "Awaiting verification"
    modifier = "verified" if verified else "unverified"
    return f'<span class="badge {modifier}"><span aria-hidden="true">●</span> {label}</span>'


def build_report(
    scan: Mapping[str, Any], patches: Sequence[Mapping[str, Any]], audit_log: Sequence[Mapping[str, Any]]
) -> str:
    """Convert collection-shaped data into a complete, standalone HTML report."""
    del audit_log  # Accepted so a real query can pass all three schema collections.
    patches_by_rule = {str(patch["violation_rule_id"]): patch for patch in patches}
    violations = list(scan.get("violations", []))
    fixed = sum(1 for violation in violations if str(violation["rule_id"]) in patches_by_rule)
    verified = sum(
        1
        for violation in violations
        if bool(patches_by_rule.get(str(violation["rule_id"]), {}).get("verified"))
    )
    cards = []
    for number, violation in enumerate(violations, start=1):
        rule_id = str(violation["rule_id"])
        patch = patches_by_rule.get(rule_id)
        wcag = WCAG_BY_RULE.get(rule_id, "WCAG mapping pending")
        if patch:
            remediation = (
                f'<div class="remediation">{code_block(str(patch["original_snippet"]), "Before")} '
                f'{code_block(str(patch["patched_snippet"]), "After")}</div>'
                f'<div class="card-footer"><span>Fixed {html.escape(format_time(patch["applied_at"]))}</span>'
                f'{status_badge(bool(patch.get("verified")))}</div>'
            )
        else:
            remediation = '<p class="not-fixed">No patch has been recorded for this finding.</p>'
        cards.append(
            f'''<article class="finding">
  <div class="finding-heading"><div><span class="finding-number">{number:02}</span><span class="severity">{html.escape(str(violation["severity"]))}</span></div>{status_badge(bool(patch and patch.get("verified")))}</div>
  <h2>{html.escape(rule_id)}</h2>
  <p class="criterion">{html.escape(wcag)}</p>
  <p class="description">{html.escape(str(violation["description"]))}</p>
  <p class="location">{html.escape(str(violation["source_file"]))} <span>·</span> {html.escape(str(violation["selector"]))}</p>
  {remediation}
</article>'''
        )

    return f'''<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Compliance audit report — {html.escape(str(scan["target_app"]))}</title>
  <style>
    :root {{ color-scheme: light; --ink:#17221d; --muted:#657268; --paper:#fbfaf6; --line:#dde2dc; --forest:#173e2d; --sage:#dfe9df; --gold:#d7a94c; --red:#9e4439; }}
    * {{ box-sizing:border-box; }} body {{ margin:0; background:#eef1ec; color:var(--ink); font:16px/1.55 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
    main {{ width:min(1080px, calc(100% - 32px)); margin:32px auto; background:var(--paper); box-shadow:0 18px 50px #19322418; }}
    header {{ background:var(--forest); color:#fff; padding:48px 56px 38px; }} .eyebrow {{ margin:0 0 14px; color:#c1d6c5; font-size:.76rem; font-weight:800; letter-spacing:.14em; text-transform:uppercase; }}
    h1 {{ max-width:700px; margin:0; font:500 clamp(2rem, 5vw, 3.75rem)/1.08 Georgia, serif; }} .scan-meta {{ margin:20px 0 0; color:#d5e1d7; }}
    .summary {{ display:grid; grid-template-columns:repeat(3, 1fr); border-bottom:1px solid var(--line); }} .summary div {{ padding:24px 56px; border-right:1px solid var(--line); }} .summary div:last-child {{ border:0; }}
    .summary strong {{ display:block; color:var(--forest); font:700 2rem/1 Georgia, serif; }} .summary span {{ color:var(--muted); font-size:.78rem; font-weight:750; letter-spacing:.08em; text-transform:uppercase; }}
    .content {{ padding:42px 56px 56px; }} .section-label {{ margin:0 0 24px; color:var(--muted); font-size:.82rem; font-weight:750; letter-spacing:.1em; text-transform:uppercase; }}
    .finding {{ padding:28px 0 30px; border-top:1px solid var(--line); }} .finding-heading, .card-footer {{ display:flex; justify-content:space-between; align-items:center; gap:16px; }}
    .finding-number {{ margin-right:9px; color:var(--muted); font-weight:800; }} .severity {{ color:var(--red); font-size:.74rem; font-weight:850; letter-spacing:.1em; text-transform:uppercase; }}
    h2 {{ margin:14px 0 3px; font:600 1.45rem/1.2 Georgia, serif; }} .criterion {{ margin:0; color:var(--forest); font-weight:700; font-size:.9rem; }} .description {{ max-width:760px; margin:14px 0 6px; }} .location {{ margin:0; color:var(--muted); font: .84rem ui-monospace, SFMono-Regular, Menlo, monospace; }} .location span {{ padding:0 5px; }}
    .remediation {{ display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:22px; }} .code-label {{ margin:0 0 7px; color:var(--muted); font-size:.74rem; font-weight:800; letter-spacing:.09em; text-transform:uppercase; }} pre {{ min-height:110px; overflow:auto; margin:0; padding:16px; background:#f0f3ee; border:1px solid var(--line); border-left:3px solid var(--gold); border-radius:4px; color:#26372c; font: .78rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space:pre-wrap; }}
    .card-footer {{ margin-top:18px; color:var(--muted); font-size:.87rem; }} .badge {{ display:inline-flex; align-items:center; gap:6px; border-radius:999px; padding:5px 10px; font-size:.76rem; font-weight:800; white-space:nowrap; }} .badge.verified {{ background:var(--sage); color:#205a39; }} .badge.unverified {{ background:#f5e5cf; color:#885414; }} .not-fixed {{ color:var(--red); font-weight:700; }}
    footer {{ padding:18px 56px; background:#f0f3ee; color:var(--muted); font-size:.82rem; }}
    @media (max-width:680px) {{ main {{ width:100%; margin:0; }} header, .content {{ padding:32px 24px; }} .summary div {{ padding:18px 24px; }} .remediation {{ grid-template-columns:1fr; }} footer {{ padding:18px 24px; }} }}
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">Accessibility remediation · Compliance audit report</p>
      <h1>{html.escape(str(scan["target_app"]))}</h1>
      <p class="scan-meta">Initial scan completed {html.escape(format_time(scan["timestamp"]))}</p>
    </header>
    <section class="summary" aria-label="Audit summary">
      <div><strong>{len(violations)}</strong><span>Total violations found</span></div>
      <div><strong>{fixed}</strong><span>Total fixed</span></div>
      <div><strong>{verified}</strong><span>Total verified</span></div>
    </section>
    <section class="content"><p class="section-label">Findings &amp; remediation record</p>{''.join(cards)}</section>
    <footer>Generated by the compliance audit report · Source collections: scans, patches, audit_log</footer>
  </main>
</body>
</html>'''


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate the compliance audit report.")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="HTML file to create")
    parser.add_argument("--target-app", help="Generate a report from the latest stored scan for this target")
    args = parser.parse_args()
    scan, patches, audit_log = load_audit_data(args.target_app)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(build_report(scan, patches, audit_log), encoding="utf-8")
    print(f"Generated {args.output}")


if __name__ == "__main__":
    main()
