#!/usr/bin/env python3
"""Record a finished fix in the team's MongoDB through the teammate's own db.mongo_store module.

Usage:
  python3 remediation/bridge/record_to_mongo.py <report.json> [--repo-root <dir>] [--dry-run]

Reads the harness report (remediation/out/<id>/report.json), then inserts one `patches` document
(insert_patch) and audit events (`patch_applied`, and `verified` when status == fixed) via MongoStore.
The scan_id comes from report.mongo_scan_id (present when the input was a MongoDB scans document);
without one, --dry-run prints the documents and a real run inserts a minimal scans document first.
Never fabricates success: exits 2 when MongoDB is unavailable, 0 on success, 1 on bad input.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def main() -> int:
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    report_path = Path(args[0])
    dry_run = "--dry-run" in args
    repo_root = Path(args[args.index("--repo-root") + 1]) if "--repo-root" in args else Path(__file__).resolve().parents[2]
    report = json.loads(report_path.read_text())
    mp = report.get("mongo_patch")
    if not mp:
        print("report has no mongo_patch record (was the fix run with the current harness?)", file=sys.stderr)
        return 1
    if report.get("status") != "fixed" and "--record-failures" not in args:
        print(f"nothing recorded: fix status is {report.get('status')!r} (pass --record-failures to log it as an audit event)")
        return 0
    events = [("patch_applied", {"violation_id": report.get("violation_id"), "rule_id": report.get("rule_id"), "status": report.get("status"), "attempts": len(report.get("attempts", []))})]
    if report.get("status") == "fixed":
        events.append(("verified", {"violation_id": report.get("violation_id"), "rule_id": report.get("rule_id"), "gates": ["diff-guard", "build", "rescan", "functional", "reviewer"]}))
    if dry_run:
        print(json.dumps({"patch": mp, "audit_events": events}, indent=2, default=str))
        return 0
    sys.path.insert(0, str(repo_root))
    try:
        from db.mongo_store import MongoStore  # teammate's module at <repo>/db
        from pymongo.errors import PyMongoError
    except ImportError as exc:
        print(f"cannot import db.mongo_store from {repo_root}: {exc}", file=sys.stderr)
        return 1
    store = MongoStore(server_selection_timeout_ms=3000)
    try:
        store.ping()
        scan_id = mp.get("scan_id")
        if not scan_id:
            scan_id = store.insert_scan(target_app=mp.get("target_app") or "unknown", violations=[mp["violation_for_scans"]])
        patch_id = store.insert_patch(
            scan_id=scan_id,
            violation_rule_id=mp["violation_rule_id"],
            source_file=mp["source_file"],
            original_snippet=mp["original_snippet"],
            patched_snippet=mp["patched_snippet"],
            model_used=mp["model_used"],
            verified=bool(mp.get("verified")),
        )
        for event_type, details in events:
            store.insert_audit_event(event_type, {**details, "patch_id": str(patch_id), "scan_id": str(scan_id)})
        print(f"RECORDED: scan {scan_id}, patch {patch_id}, {len(events)} audit event(s)")
        return 0
    except PyMongoError as exc:
        print(f"MongoDB unavailable, nothing recorded: {exc}", file=sys.stderr)
        return 2
    finally:
        store.close()


if __name__ == "__main__":
    raise SystemExit(main())
