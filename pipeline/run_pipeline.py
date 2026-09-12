#!/usr/bin/env python3
"""Run the repository's real axe scanner and persist its native result shape.

There is no local remediation agent in this checkout.  This module therefore
does not manufacture patches: it records only findings produced by
``scripts/a11y-scan.js`` and audit events permitted by ``MongoStore``.
"""

from __future__ import annotations

import json
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

from db.mongo_store import MongoStore


ROOT = Path(__file__).resolve().parents[1]
SCANNER = ROOT / "scripts" / "a11y-scan.js"
REPORT = ROOT / "reports" / "a11y-report.json"


def _record_stage(store: MongoStore, *, run_id: str, target: str, trigger_source: str, stage: str, **extra: Any) -> None:
    """Use the existing ``scan_run`` event type; stage is documented extra data."""
    store.insert_audit_event("scan_run", {
        "run_id": run_id,
        "target_app": target,
        "trigger_source": trigger_source,
        "stage": stage,
        **extra,
    })


def _violations_from_axe(results: dict[str, Any], target: str) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    for violation in results.get("violations", []):
        for node in violation.get("nodes", []):
            findings.append({
                "rule_id": str(violation.get("id", "unknown-rule")),
                "selector": " ".join(str(part) for part in node.get("target", [])) or "unknown selector",
                "severity": str(violation.get("impact") or "unknown"),
                "description": " ".join(part for part in [str(violation.get("help", "")), str(node.get("failureSummary", ""))] if part),
                "source_file": target,
            })
    return findings


def run_pipeline(target: str, trigger_source: str) -> dict[str, Any]:
    """Execute the real scanner, insert a scan, and log the real source/stage."""
    if trigger_source not in {"automatic", "manual"}:
        raise ValueError("trigger_source must be 'automatic' or 'manual'")
    run_id = str(uuid.uuid4())
    store = MongoStore(server_selection_timeout_ms=2_500)
    try:
        store.ping()
        store.ensure_indexes()
        _record_stage(store, run_id=run_id, target=target, trigger_source=trigger_source, stage="scan")
        completed = subprocess.run(
            ["node", str(SCANNER), target], cwd=ROOT, capture_output=True, text=True, timeout=90,
        )
        # Axe returns 1 when it found violations; that is a successful scan.
        if completed.returncode not in {0, 1}:
            raise RuntimeError(completed.stderr.strip() or "The axe scanner failed")
        if not REPORT.exists():
            raise RuntimeError("The axe scanner did not write reports/a11y-report.json")
        results = json.loads(REPORT.read_text(encoding="utf-8"))
        _record_stage(store, run_id=run_id, target=target, trigger_source=trigger_source, stage="locate")
        findings = _violations_from_axe(results, target)
        scan_id = store.insert_scan(target, findings)
        _record_stage(
            store, run_id=run_id, target=target, trigger_source=trigger_source,
            stage="record", scan_id=str(scan_id), complete=True, violation_count=len(findings),
        )
        return {"run_id": run_id, "scan_id": str(scan_id), "target_app": target, "violation_count": len(findings)}
    finally:
        store.close()


if __name__ == "__main__":
    target_arg = sys.argv[1] if len(sys.argv) > 1 else str(ROOT / "demo" / "index.html")
    print(json.dumps(run_pipeline(target_arg, "manual")))
