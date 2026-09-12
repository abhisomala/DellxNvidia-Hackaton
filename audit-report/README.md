# Compliance audit report

`generate_report.py` renders a standalone HTML report (plus a JSON sidecar)
from a real query over the `scans`, `patches`, and `audit_log` collections
defined in [`../db/mongo_store.py`](../db/mongo_store.py). There is no
fake-data path: with nothing reportable in the database it exits non-zero and
writes nothing.

## Run it

From the repository root:

```bash
python3 audit-report/generate_report.py                         # newest real scan
python3 audit-report/generate_report.py --target-app demo/index.html
python3 audit-report/generate_report.py --scan-id <objectid>
python3 audit-report/generate_report.py --any-scan              # drop the filters
```

Output lands in `audit-report/out/audit-report.html` and `audit-report.json`;
pass `--out-dir` to write elsewhere. The HTML carries its own CSS, so it opens
without a web server. Connection settings come from `MONGODB_URI` and
`MONGODB_DATABASE`, as for `MongoStore`.

## Which scan is picked

Without `--scan-id`, `pick_default_scan()` takes the newest scan that came from
a real Path 1 report (it has `scanner_metadata`) and skips verification
rescans, `roundtrip-smoke-test` records and Path 2 bridge stubs. `--target-app`
narrows that search to one site. See `DEMO.md` §4.

## Use from code

The dashboard's report view calls the same functions in-process:

```python
store = MongoStore(server_selection_timeout_ms=3000)
try:
    data = report.collect(store, None, target_app="demo/index.html")
    html = report.render_html(data, store.database.name)
except LookupError:
    ...  # nothing reportable for that site
finally:
    store.close()
```

`collect()` raises `LookupError` rather than exiting, so a caller can render
"no report yet"; the command-line entry point turns that into a non-zero exit.
