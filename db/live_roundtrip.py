"""Run a real MongoDB insert/query smoke test; never reports a false success."""

from __future__ import annotations

import sys
from uuid import uuid4

from pymongo.errors import PyMongoError

from .mongo_store import MongoStore


def main() -> int:
    # A bounded timeout makes an unavailable local service a fast, truthful skip.
    store = MongoStore(server_selection_timeout_ms=3_000)
    run_id = str(uuid4())
    try:
        store.ping()
        store.ensure_indexes()

        scan_id = store.insert_scan(
            target_app="roundtrip-smoke-test",
            violations=[
                {
                    "rule_id": "sample-rule",
                    "selector": "button.submit",
                    "severity": "low",
                    "description": "Synthetic record used only for database connectivity testing.",
                    "source_file": "sample.py",
                    "test_run_id": run_id,
                }
            ],
        )
        patch_id = store.insert_patch(
            scan_id=scan_id,
            violation_rule_id="sample-rule",
            source_file="sample.py",
            original_snippet="unsafe_example()",
            patched_snippet="safe_example()",
            model_used="roundtrip-smoke-test",
        )
        event_id = store.insert_audit_event(
            "scan_run", {"test_run_id": run_id, "scan_id": str(scan_id)}
        )

        scan = store.get_scan(scan_id)
        patch = store.get_patch(patch_id)
        event = store.get_audit_event(event_id)
        if not (scan and patch and event):
            raise RuntimeError("a document could not be queried back after insertion")
        if patch["scan_id"] != scan_id or event["details"]["test_run_id"] != run_id:
            raise RuntimeError("queried documents did not preserve their expected references/details")

        print(
            "LIVE ROUND-TRIP PASSED: inserted and queried one sample document in "
            f"scans ({scan_id}), patches ({patch_id}), and audit_log ({event_id})."
        )
        return 0
    except PyMongoError as exc:
        print(
            "LIVE ROUND-TRIP SKIPPED: no usable MongoDB connection was available. "
            "Run this script on the MongoDB host before trusting persistence. "
            f"Details: {exc}",
            file=sys.stderr,
        )
        return 2
    finally:
        store.close()


if __name__ == "__main__":
    raise SystemExit(main())
