# Demo day runbook

The chain is **scan → insert → patch → verify → record → audit report**, driven by
one command. This file is the startup sequence, the restore path, and an honest
statement of what is real and what is not.

Working directory: `/home/dell/DellxNvidia-Hackaton`, on `main`. Path 1's
pipeline, the GuardRail dashboard and Path 2's harness (`remediation/`) all live
in this one checkout. **Path 2's harness writes to the same MongoDB database** — see §5.

Health check for everything below in one command: `scripts/mongo-check.sh`.

---

## 1. Startup sequence

### a. Confirm MongoDB is running under systemd

```bash
systemctl --user status mongod-local
```

Expect `Active: active (running)`. It is a **user** unit, so `--user` is required
and `sudo` is not. Lingering is on (`loginctl show-user dell | grep Linger` →
`Linger=yes`), so it starts at boot without anyone logging in.

If it is not running:

```bash
systemctl --user start mongod-local
journalctl --user -u mongod-local -n 50 --no-pager    # if it fails to start
```

> Do **not** use `sudo systemctl start mongod`. The packaged `mongod.service` was
> removed: it refuses to run on this kernel (`7.0.0-1019-nvidia` — MongoDB blocks
> kernels ≥ 6.19, SERVER-121912). A stale
> `/etc/systemd/system/multi-user.target.wants/mongod.service` symlink still
> dangles and reports a confusing failure if you try. `mongod-local` runs the
> working tarball build in `/home/dell/opt/mongodb/mongodb-7.0.43/`
> against dbpath `/home/dell/mongodb-data`.

### b. Confirm port 27017 is reachable

```bash
ss -ltn | grep 27017
mongosh --quiet --eval 'db.runCommand({ping:1})'
```

Expect `127.0.0.1:27017` listening and `{ ok: 1 }`.

Deeper check — pings, creates indexes, round-trips a document through all three
collections:

```bash
python3 -m db.live_roundtrip      # prints LIVE ROUND-TRIP PASSED, exit 0
```

> This **inserts three synthetic documents** every time it runs
> (`target_app: "roundtrip-smoke-test"`). That is harmless — the report
> generator will not pick them (§4) — but it is why the collections grow if you
> run it repeatedly.

### c. Run the pipeline

```bash
cd /home/dell/DellxNvidia-Hackaton
MONGODB_URI='mongodb://localhost:27017' MONGODB_DATABASE='scanner' \
  python3 pipeline/run_pipeline.py
```

Exit 0 means every stage passed. It prints the `scan_id`, `patch_id`,
`verification_scan_id` and the verification verdict, and writes the report to
`audit-report/out/audit-report.html`. Per-run artifacts — both axe reports, the
diff, the patched copy, the functional-check log and a summary — land in
`pipeline/runs/<timestamp>/`.

Every stage fails loudly. No stage falls back to placeholder data.

### d. Dashboard

The GuardRail dashboard runs as a user service on http://127.0.0.1:4173 and
starts the watcher itself (one pipeline run per `GUARDRAIL_WATCH_INTERVAL_SECONDS`):

```bash
systemctl --user status guardrail-dashboard
journalctl --user -u guardrail-dashboard -n 50 --no-pager
```

Its settings — including which database it reads (`MONGODB_DATABASE`) — are in
`~/.config/guardrail.env`; restart the unit after editing. The unit file and a
template env live in `deploy/`.

### e. Standalone commands

```bash
node scripts/a11y-scan.js                        # Path 1 only (exit 1 = violations found)
node integrity-check/check.js                    # 13 behaviour checks on the demo app
python3 audit-report/generate_report.py          # regenerate from the newest real scan
python3 audit-report/generate_report.py --scan-id <id>
```

---

## 2. Restore if something breaks

Known-good snapshot (taken 2026-09-12T17:06:05Z, restore-tested):

```
/home/dell/backups/known-good-20260912-170659
```

Restore over the live database:

```bash
mongorestore --uri="mongodb://127.0.0.1:27017" --drop \
  "/home/dell/backups/known-good-20260912-170659"
```

`--drop` replaces the `scanner` collections with the snapshot's contents.
To inspect a dump without touching live data, restore it under another name:

```bash
mongorestore --uri="mongodb://127.0.0.1:27017" --drop \
  --nsFrom='scanner.*' --nsTo='scanner_restore_test.*' \
  "/home/dell/backups/known-good-20260912-170659"
```

Take a fresh snapshot before anything risky:

```bash
mongodump --uri="mongodb://127.0.0.1:27017" --db=scanner \
  --out=/home/dell/backups/known-good-$(date +%Y%m%d-%H%M%S)
```

Other snapshots in `/home/dell/backups/`: `pre-systemd-*` and `pre-cleanup-*`
cover both databases (`scanner` and the unrelated `scan_patch_db`).

---

## 3. What is real, and what is not

**Real, end to end, every run:**

- the scan — Playwright + axe-core 4.13.0 over `demo/index.html`, run fresh
- the finding — `button-name` on `.bag-button`, impact `critical`
- every database record, written through `db/mongo_store.py`
- the patch *recording* — done by Path 2's own `remediation/bridge/record_to_mongo.py`,
  invoked directly now that Path 2's harness lives in this repository
- **verification** — the patch is applied to a copy and Path 1 is really re-run
  over it; `verified` comes from that rescan plus the 13-check functional test,
  never from an assertion. Break the patch and the run reports `VERIFIED=False`.

**Simulated — the patch content only:**

`pipeline/patch_stub.py` generates the patch by a deterministic rule. Patch
records carry `model_used = "simulated:pipeline.patch_stub (no Path 2 output
available)"` and the HTML report shows a banner saying so, so a simulated patch
cannot be mistaken for an agent-authored one.

Two of Path 2's five gates really run (**rescan**, **functional**). `build` does
not apply — the demo is static HTML. The **diff guard** and the **model
reviewer** belong to Path 2's harness and do not run here. Each `verified` audit
event records exactly this in `details.gates` / `gates_not_run` /
`gates_not_applicable`.

**The demo app is never modified.** The patch is applied to a copy under
`pipeline/runs/<timestamp>/verify/`, so the planted violation stays in
`demo/index.html` and the demo is repeatable.

---

## 4. Which scan the report picks

`generate_report.py` with no arguments reports on the newest scan that came from
a real Path 1 report — it requires the `scanner_metadata` field, which only
`MongoStore.insert_axe_scan` writes. It skips, and says which it skipped:

- **verification rescans** — they legitimately show zero violations;
- **synthetic** `roundtrip-smoke-test` scans from `db/live_roundtrip.py`;
- **Path 2 bridge stubs** — `record_to_mongo.py` inserts a minimal scan with
  `target_app: "unknown"` when its report carries no `scan_id`.

`--scan-id <id>` reports on any scan; `--any-scan` drops the filters. There is no
fake-data path: with nothing reportable it exits non-zero and writes nothing.

---

## 5. The database is shared — read this before the demo

`scanner` is the team default (`db/README.md`), and **Path 2's harness writes to
it too**. Records with `model_used: "openclaw-agent"` and
`source_file: "src/components/UploadButton.jsx"` are Path 2's real output against
its own React fixture app; they arrive through its own bridge, independently of
this pipeline, and currently land with `target_app: "unknown"`, `verified: false`
and no `verification_scan_id`.

Consequences:

- document counts drift between runs without anyone touching this pipeline, so a
  snapshot is a point-in-time copy of **both** teams' records;
- `mongorestore --drop` would roll back Path 2's records too. Coordinate before
  restoring, or restore under a scratch namespace first (§2);
- the report's scan selection is already hardened against their stubs (§4).

To decouple the demo entirely, run the pipeline against its own database:

```bash
MONGODB_DATABASE='scanner_demo' python3 pipeline/run_pipeline.py
MONGODB_DATABASE='scanner_demo' python3 audit-report/generate_report.py
```

That is a deliberate choice, not the default — the shared `scanner` database is
what makes both paths show up in one audit trail.

### Known synthetic records

Three `db/live_roundtrip.py` records are kept on purpose — they are the evidence
that the managed `mongod` serves the original dbpath:

| collection | `_id` | marker |
|---|---|---|
| `scans` | `6aa579d6eb2ad7169b027d56` | `target_app: "roundtrip-smoke-test"`, rule `sample-rule` |
| `patches` | `6aa579d6eb2ad7169b027d57` | `model_used: "roundtrip-smoke-test"` |
| `audit_log` | `6aa579d6eb2ad7169b027d58` | `scan_run` with a `test_run_id` |
