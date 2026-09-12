# GuardRail

## Local dashboard

Install the scanner's MongoDB dependency once:

```sh
python3 -m pip install -r db/requirements.txt
```

Then start the dashboard with one command:

```sh
python3 dashboard_server.py
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). The server reads
`MONGODB_URI` and `MONGODB_DATABASE` through `db/mongo_store.py`; it does not
send MongoDB credentials or scan data to the browser. If the local database is
unavailable or contains no scans, the dashboard intentionally shows that state
instead of sample records.

Starting the server also starts the independent local watcher. It invokes the
repository's real axe scanner on `demo/index.html` every 60 seconds by default
and records `trigger_source: "automatic"` on its `audit_log` scan events.
Override the interval or target with `GUARDRAIL_WATCH_INTERVAL_SECONDS` and
`GUARDRAIL_WATCH_TARGET`. The dashboard's **Scan Now** control invokes the
same pipeline with `trigger_source: "manual"`; it does not replace monitoring.
