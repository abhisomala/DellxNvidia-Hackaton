# MongoDB persistence module

`mongo_store.py` provides a small PyMongo repository for these collections:

- `scans`: timestamp, target application, and a list of violation dictionaries.
- `patches`: the originating scan reference, patch content/metadata, and optional verification scan reference.
- `audit_log`: `scan_run`, `patch_applied`, or `verified` events and arbitrary detail data.

The MongoDB URI defaults to `mongodb://localhost:27017`. It may instead be supplied with `MONGODB_URI`; `MONGODB_DATABASE` defaults to `scanner`. No machine-specific host or path is baked into the module.

## Run on the real MongoDB machine

From the repository root, run the following exact commands:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r db/requirements.txt
export MONGODB_URI='mongodb://localhost:27017'
export MONGODB_DATABASE='scanner'
python -m db.live_roundtrip
```

The final command pings MongoDB, creates supporting indexes, inserts one clearly labeled synthetic document into each collection, and queries every document back. A zero exit code and `LIVE ROUND-TRIP PASSED` is the only successful result. Exit code `2` and `LIVE ROUND-TRIP SKIPPED` means the connection was not available; run it on the actual MongoDB host before relying on this persistence layer.

## Use from application code

```python
from db.mongo_store import MongoStore

store = MongoStore()
scan_id = store.insert_scan(
    target_app="my-app",
    violations=[{
        "rule_id": "no-inline-style",
        "selector": ".checkout",
        "severity": "medium",
        "description": "Inline styles found.",
        "source_file": "src/checkout.html",
    }],
)
patch_id = store.insert_patch(
    scan_id, "no-inline-style", "src/checkout.html",
    "style=\"...\"", "class=\"checkout\"", "model-name",
)
store.insert_audit_event("patch_applied", {"patch_id": str(patch_id)})

# Each collection has a get-by-id and filtered query method.
recent_scans = store.find_scans({"target_app": "my-app"}, limit=20)
recent_patches = store.find_patches({"scan_id": scan_id})
events = store.find_audit_events({"event_type": "patch_applied"})
store.close()
```

## Draft violations contract

The agreed keys are collected in `VIOLATION_CORE_FIELDS` near the top of `mongo_store.py`. The module validates only that shallow list and saves extra keys unchanged. When the detection-output contract is finalized, adjust that single list (or relax it further) rather than changing nested model classes or migration-heavy code.
