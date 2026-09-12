# Compliance audit report

This directory generates a polished, standalone HTML closing artifact for the
accessibility demo. It consumes the existing `scans`, `patches`, and
`audit_log` document shapes defined in [`../db/mongo_store.py`](../db/mongo_store.py).

## Run it

From the repository root:

```bash
python3 audit-report/generate_report.py
open audit-report/compliance-audit-report.html
```

Pass `--output path/to/report.html` to write the report elsewhere. The
generated HTML contains all its CSS, so it is easy to open, present, or share
without a web server.

To generate a report from the latest real scan for one registered target:

```bash
python3 audit-report/generate_report.py --target-app "my-app"
```

This reads the connection settings used by `MongoStore` (`MONGODB_URI` and
`MONGODB_DATABASE`), finds the target's latest scan, then uses only patches
and audit events linked to that scan. The dashboard's **Generate report**
action invokes this same data-loading and rendering path.

## Demo fixture

`load_audit_data()` is the only data-source function. For the live-demo
fixture it returns one `scans` document with the three staged Harbor & Pine
issues, their `patches` records, and matching `audit_log` entries:

- `button-name`: the empty shopping-bag button;
- `label`: the email input with a placeholder but no label;
- `modal-focus-management`: Tab is always suppressed and opening focus is not restored.

The rendered report maps each rule to its WCAG criterion, shows the recorded
before/after snippets, patch timestamp, and verification state. The current
fixture marks all three recorded patches as verified, so the summary is 3
found, 3 fixed, 3 verified.

## Data shape

`load_audit_data()` returns this tuple to the rendering layer:

```python
(scan_document, patch_documents, audit_log_documents)
```

The `--target-app` option queries it from MongoDB using the repository's store
API. Calling the script without that option continues to render the existing
fixture as a visual example only.

```python
from db.mongo_store import MongoStore

def load_audit_data():
    store = MongoStore()
    try:
        scan = store.find_scans(limit=1)[0]
        patches = store.find_patches({"scan_id": scan["_id"]})
        audit_log = store.find_audit_events({"details.scan_id": scan["_id"]})
        return scan, patches, audit_log
    finally:
        store.close()
```

If a reporting query includes several scans, select the intended scan first,
then return only patches whose `scan_id` matches it. `ObjectId` values can be
returned directly: the report uses rule IDs for joins and formats dates safely.
