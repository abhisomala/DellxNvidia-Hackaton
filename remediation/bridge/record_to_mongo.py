#!/usr/bin/env python3
"""Record a finished fix in the team's MongoDB through the teammate's own db.mongo_store module.

Usage:
  python3 remediation/bridge/record_to_mongo.py <report.json> [--repo-root <dir>] [--dry-run] [--record-failures]

Reads the harness report (remediation/out/<id>/report.json), then inserts one `patches` document
(insert_patch) and audit events (`patch_applied`, and `verified` when status == fixed) via MongoStore.
The scan_id comes from report.mongo_patch.scan_id (present when the input was a MongoDB scans
document); without one, --dry-run prints the documents and a real run inserts a minimal scans
document first.

A run that did not produce a verified patch records nothing unless --record-failures is given, and
even then only an audit event: a rolled-back fix has no patch, so no `patches` document is written.

Never fabricates success: exits 0 on success, 1 on bad input, 2 when MongoDB is unavailable.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

USAGE = "usage: record_to_mongo.py <report.json> [--repo-root <dir>] [--dry-run] [--record-failures]"
FLAGS = {"--dry-run", "--record-failures"}


def parse_args(argv: list[str]):
    """Hand-rolled parsing, but strict: a missing value or a stray flag is an error, not a crash."""
    positional: list[str] = []
    repo_root: Path | None = None
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--repo-root":
            if i + 1 >= len(argv):
                raise ValueError("--repo-root needs a directory")
            repo_root = Path(argv[i + 1])
            i += 2
            continue
        if arg in FLAGS:
            i += 1
            continue
        if arg.startswith("-"):
            raise ValueError(f"unknown option {arg!r}\n{USAGE}")
        positional.append(arg)
        i += 1
    if len(positional) != 1:
        raise ValueError(f"expected exactly one <report.json> path, got {len(positional)}\n{USAGE}")
    return positional[0], (repo_root or Path(__file__).resolve().parents[2])


def main() -> int:
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    try:
        report_arg, repo_root = parse_args(args)
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 1

    report_path = Path(report_arg)
    try:
        report = json.loads(report_path.read_text())
    except FileNotFoundError:
        print(f"report not found: {report_path}", file=sys.stderr)
        return 1
    except IsADirectoryError:
        print(f"not a file: {report_path}", file=sys.stderr)
        return 1
    except json.JSONDecodeError as exc:
        print(f"{report_path} is not valid JSON: {exc}", file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"cannot read {report_path}: {exc}", file=sys.stderr)
        return 1
    if not isinstance(report, dict):
        print(f"{report_path} does not contain a report object", file=sys.stderr)
        return 1

    dry_run = "--dry-run" in args
    record_failures = "--record-failures" in args

    mp = report.get("mongo_patch")
    if not mp:
        print("report has no mongo_patch record (was the fix run with the current harness?)", file=sys.stderr)
        return 1

    status = report.get("status")
    verified = status == "fixed"
    if not verified and not record_failures:
        print(f"nothing recorded: fix status is {status!r} (pass --record-failures to log it as an audit event)")
        return 0

    events = [("patch_applied", {
        "violation_id": report.get("violation_id"),
        "rule_id": report.get("rule_id"),
        "status": status,
        "attempts": len(report.get("attempts", [])),
    })]
    if verified:
        events.append(("verified", {
            "violation_id": report.get("violation_id"),
            "rule_id": report.get("rule_id"),
            "gates": ["diff-guard", "build", "rescan", "functional", "reviewer"],
        }))

    if dry_run:
        print(json.dumps({
            "patch": mp if verified else None,
            "patch_skipped_reason": None if verified else f"status is {status!r}: no verified patch to record",
            "audit_events": events,
        }, indent=2, default=str))
        return 0

    sys.path.insert(0, str(repo_root))
    try:
        from db.mongo_store import MongoStore  # teammate's module at <repo>/db
        from pymongo.errors import PyMongoError
    except ImportError as exc:
        print(f"cannot import db.mongo_store from {repo_root}: {exc}", file=sys.stderr)
        return 1

    # Constructed inside the try: a malformed MONGODB_URI raises from MongoClient itself, and
    # that must be the documented exit 2, not an uncaught traceback.
    store = None
    try:
        store = MongoStore(server_selection_timeout_ms=3000)
        store.ping()
        scan_id = mp.get("scan_id")
        patch_id = None
        if verified:
            if not scan_id:
                scan_id = store.insert_scan(
                    target_app=mp.get("target_app") or "unknown",
                    violations=[mp["violation_for_scans"]],
                )
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
            store.insert_audit_event(event_type, {
                **details,
                "patch_id": str(patch_id) if patch_id else None,
                "scan_id": str(scan_id) if scan_id else None,
            })
        if verified:
            print(f"RECORDED: scan {scan_id}, patch {patch_id}, {len(events)} audit event(s)")
        else:
            print(f"RECORDED: {len(events)} audit event(s) only (status {status!r}; no patch to store)")
        return 0
    except PyMongoError as exc:
        print(f"MongoDB unavailable, nothing recorded: {exc}", file=sys.stderr)
        return 2
    except (ValueError, TypeError, KeyError) as exc:
        # db.mongo_store validates its own contract with plain ValueError/TypeError
        # (_as_object_id, _normalise_violations); those are bad input, not a DB outage.
        print(f"cannot record this report: {exc}", file=sys.stderr)
        return 1
    finally:
        if store is not None:
            try:
                store.close()
            except Exception:  # noqa: BLE001 - closing must never mask the real outcome
                pass


if __name__ == "__main__":
    raise SystemExit(main())
