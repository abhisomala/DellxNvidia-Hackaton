"""Adapt the accessibility scanner's real axe-core output to the scans schema.

Path 1 (``scripts/a11y-scan.js``) emits a raw axe-core result object.  Its
violation shape does not match ``VIOLATION_CORE_FIELDS`` in ``mongo_store``:

===================  ==================================================
scans schema         raw axe-core violation
===================  ==================================================
``rule_id``          ``id``
``selector``         ``nodes[].target`` (a list, one level deeper)
``severity``         ``impact`` (may be null)
``description``      ``description`` (the only direct match)
``source_file``      absent; only the top-level ``url`` identifies a file
===================  ==================================================

axe also groups by rule, so one violation carries N failing elements in
``nodes``.  The scans schema stores one selector per violation entry, so this
module fans a rule out into one entry per node.  Producer-specific keys are
carried through unchanged, which is what the store's shallow validation is
there to allow.
"""

from __future__ import annotations

import os
from collections.abc import Mapping, Sequence
from typing import Any
from urllib.parse import unquote, urlparse

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

UNKNOWN_SEVERITY = "unknown"
UNKNOWN_SOURCE = "unknown"


def source_file_from_url(url: str | None, *, base_dir: str | None = None) -> str:
    """Turn an axe ``url`` into the repo-relative file that produced it.

    ``file://`` targets become a path relative to ``base_dir`` (the repository
    root by default) so downstream patch tooling can locate the real file.
    Remote targets keep a URL-ish identifier instead of inventing a path.
    """
    if not url:
        return UNKNOWN_SOURCE
    parsed = urlparse(url)
    if parsed.scheme in ("", "file"):
        path = unquote(parsed.path)
        root = os.path.abspath(base_dir or REPO_ROOT)
        absolute = os.path.abspath(path)
        relative = os.path.relpath(absolute, root)
        # Only prefer the relative form when the target really sits under root.
        return path if relative.startswith(os.pardir) else relative
    return f"{parsed.netloc}{parsed.path}" or url


def _selector_from_target(target: Any) -> str:
    """Render axe's target list the same way the scanner's own report does."""
    if isinstance(target, str):
        return target
    if isinstance(target, Sequence):
        return " ".join(str(part) for part in target)
    return str(target)


def violations_from_axe_report(
    report: Mapping[str, Any],
    *,
    source_file: str | None = None,
    base_dir: str | None = None,
) -> list[dict[str, Any]]:
    """Flatten a raw axe-core report into scans-collection violation entries.

    One entry per failing element.  ``source_file`` overrides the path derived
    from the report's ``url``, which is what a remote scan of a local checkout
    needs.
    """
    resolved_source = source_file or source_file_from_url(
        report.get("url"), base_dir=base_dir
    )
    entries: list[dict[str, Any]] = []

    for violation in report.get("violations") or []:
        rule_id = violation.get("id")
        rule_impact = violation.get("impact")
        nodes = violation.get("nodes") or [{}]
        for node in nodes:
            checks = [
                check.get("message")
                for group in ("any", "all", "none")
                for check in node.get(group) or []
                if check.get("message")
            ]
            entries.append(
                {
                    # The agreed core contract.
                    "rule_id": rule_id,
                    "selector": _selector_from_target(node.get("target")),
                    "severity": node.get("impact") or rule_impact or UNKNOWN_SEVERITY,
                    "description": violation.get("description"),
                    "source_file": resolved_source,
                    # Producer-specific detail, stored unchanged.
                    "help": violation.get("help"),
                    "help_url": violation.get("helpUrl"),
                    "tags": list(violation.get("tags") or []),
                    "wcag_tags": [
                        tag
                        for tag in violation.get("tags") or []
                        if str(tag).startswith("wcag")
                    ],
                    "target": list(node.get("target") or []),
                    "html": node.get("html"),
                    "failure_summary": node.get("failureSummary"),
                    "failed_checks": checks,
                    "scanner": "axe-core",
                    # Deterministic DOM findings (axe-core and the axe-shaped keyboard
                    # probe); vision findings carry source "vision" and a model confidence.
                    "source": "axe",
                    "confidence": 1.0,
                }
            )
    return entries


def target_app_from_report(report: Mapping[str, Any], *, base_dir: str | None = None) -> str:
    """Derive a stable target-app label from the scanned URL."""
    return source_file_from_url(report.get("url"), base_dir=base_dir)


def scan_metadata_from_report(report: Mapping[str, Any]) -> dict[str, Any]:
    """Collect the report-level provenance worth keeping next to a scan."""
    engine = report.get("testEngine") or {}
    return {
        "scanner_url": report.get("url"),
        "scanner_timestamp": report.get("timestamp"),
        "engine_name": engine.get("name"),
        "engine_version": engine.get("version"),
        "counts": {
            "violations": len(report.get("violations") or []),
            "passes": len(report.get("passes") or []),
            "incomplete": len(report.get("incomplete") or []),
            "inapplicable": len(report.get("inapplicable") or []),
        },
    }
