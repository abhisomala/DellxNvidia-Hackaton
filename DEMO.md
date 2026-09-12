# Demo day runbook

The chain is **scan → insert → vision → patch → verify → record → audit report**, driven by
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

### b2. Vision model (once per machine) and cache warm-up

```bash
bash vision/setup.sh      # confirms gemma4:26b has vision+tools+thinking, builds guardrail-vision
```

`guardrail-vision` is `FROM gemma4:26b` with `num_ctx 32768` pinned in
`vision/Modelfile` (4x the largest vision call, and equal to this server's
`OLLAMA_CONTEXT_LENGTH`, so it shares one loaded runner with patching and the reviewer) and Gemma 4's recommended sampling (temperature 1.0, top_p 0.95,
top_k 64). A cold vision audit makes 5 thinking calls and takes **about 4–5 minutes**
on the GB10. Judgements are cached by the exact request (screenshots + facts +
prompt version + model), so **run the pipeline once before filming**: every later
run over unchanged pixels reuses the judgement in seconds, and the log, the
dashboard and the report say it was reused. `--fresh` on
`pipeline/vision_audit.py`, or deleting `runtime/vision-cache/`, forces a new one.

### c. Run the pipeline

```bash
cd /home/dell/DellxNvidia-Hackaton
MONGODB_URI='mongodb://localhost:27017' MONGODB_DATABASE='scanner' \
  python3 pipeline/run_pipeline.py
```

Exit 0 means every stage passed **and all six gates passed**. It prints the
`scan_id`, `patch_id`, `verification_scan_id`, a gate table and the verdict, and
writes the report to `audit-report/out/audit-report.html`. Per-run artifacts —
the merged baseline/verify scans (`axe-*.json`) and the keyboard probe's own
reports (`keyboard-*.json`), the prompt, model response and diff, the patched
copy, `gates.json`, `reviewer.json`, the functional-check log and a summary —
land in `pipeline/runs/<timestamp>/`.

Useful flags:

```bash
python3 pipeline/run_pipeline.py --rule button-name            # CASE 1: the empty bag button
python3 pipeline/run_pipeline.py --rule keyboard-unreachable   # CASE 2: the shop-hours dialog
python3 pipeline/run_pipeline.py --rule button-name --in-place # patch the REAL demo file
python3 pipeline/run_pipeline.py --no-vision                   # skip the vision audit (visual gate not-applicable)
```

`--in-place` backs the real file up to `pipeline/runs/<timestamp>/original-<name>`,
writes the patch into `demo/`, and gates the real page. If any gate does not pass
(or the run breaks before the patch is recorded) the original text is written
back and the log says so in capitals. Only a verified, recorded patch stays.
After an in-place fix the planted violation is gone — `git checkout demo/` resets
the demo.

Every stage fails loudly. No stage falls back to placeholder data. A run whose
gates do not all pass exits 1 with `NOT VERIFIED: gate(s) did not pass: ...`.

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
node scripts/keyboard-scan.js demo/index.html    # keyboard probe: real Tab/Escape presses in dialogs
node integrity-check/check.js                    # 13 behaviour checks on the demo app
python3 pipeline/vision_audit.py demo/index.html  # vision audit only (runs axe first for dedupe; --fresh skips the cache)
node scripts/vision-capture.js demo/index.html --out /tmp/cap   # just the screenshots/facts the model sees
python3 audit-report/generate_report.py          # regenerate from the newest real scan
python3 audit-report/generate_report.py --scan-id <id>
```

### f. Optional: patches through NemoClaw/OpenShell

Off by default. With `GUARDRAIL_PATCH_BACKEND=nemoclaw` the patch prompt goes to the
OpenClaw agent inside a NemoClaw sandbox (OpenShell: deny-by-default egress, logged
turns) instead of straight to Ollama. OpenShell routes the agent's inference to the
same host Ollama `gemma4:26b`, so the model does not change. Everything after the
model call (splice, validate, five gates, Mongo, report) is identical; `model_used`
reads `nemoclaw:guardrail/ollama:gemma4:26b`. Code: `pipeline/patch_nemoclaw.py`.

One-time host setup (sudo):

```bash
sudo usermod -aG docker dell                  # then log out and back in (or prefix commands with sg docker -c)
sudo mkdir -p /etc/systemd/system/ollama.service.d
printf '[Service]\nEnvironment="OLLAMA_HOST=127.0.0.1:11434"\nEnvironment="OLLAMA_CONTEXT_LENGTH=32768"\n' \
  | sudo tee /etc/systemd/system/ollama.service.d/nemoclaw.conf
sudo systemctl daemon-reload && sudo systemctl restart ollama
```

Keep Ollama on loopback: NemoClaw (v0.0.123) puts its own authenticated proxy on
`:11435` in front of it for the sandbox, and its onboarding refuses a `0.0.0.0` bind
when it cannot use passwordless sudo. The context length must be at least 16384.

Install NemoClaw + OpenShell and onboard a sandbox on Ollama (not vLLM, not Nemotron):

```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_AGENT=openclaw NEMOCLAW_SANDBOX_NAME=guardrail \
  NEMOCLAW_PROVIDER=ollama NEMOCLAW_MODEL=gemma4:26b NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 bash
# if onboarding stops part-way, fix the cause and continue from the failed step:
#   NEMOCLAW_PROVIDER=ollama NEMOCLAW_MODEL=gemma4:26b nemoclaw onboard --resume --name guardrail --non-interactive
bash scripts/nemoclaw-check.sh                # status, doctor, policy, one agent turn
```

Run with it:

```bash
GUARDRAIL_PATCH_BACKEND=nemoclaw python3 pipeline/patch_llm.py --rule button-name
GUARDRAIL_PATCH_BACKEND=nemoclaw python3 -m pipeline.run_pipeline --rule button-name
python3 pipeline/tests/nemoclaw_backend.py    # fake-CLI checks; add --real for one sandbox turn
```

For the dashboard, set the variables in `~/.config/guardrail.env` (see
`deploy/guardrail.env.example`), add the `nemoclaw` directory to the unit's PATH, and
restart the unit. To switch back, unset `GUARDRAIL_PATCH_BACKEND` (or set it to `ollama`).

On camera: `nemoclaw guardrail status`, `nemoclaw guardrail policy list` (the egress
policy the agent runs under) and the `model_used` field in the report.

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

- the scan — Playwright + axe-core 4.13.0 over `demo/index.html`, run fresh, plus
  the keyboard probe (`scripts/keyboard-scan.js`), which opens each dialog and
  presses real Tab / Shift+Tab / Escape keys in Chromium; both land in one `scans`
  document
- the findings — `button-name` on `.bag-button` (axe, impact `critical`) and
  `keyboard-unreachable` on `#hours-modal` (the probe, WCAG 2.1.1: Tab never
  reaches *Get directions*; axe cannot see this)
- the vision audit — `scripts/vision-capture.js` screenshots the page in Chromium at
  1280px and 320px (1280px at 400% zoom), presses Tab through every control and
  screenshots each one focused and unfocused, and asks axe which contrast checks it
  could *not* decide; `pipeline/vision_audit.py` sends crops to `guardrail-vision`
  (gemma4:26b) through Ollama `/api/chat` with a JSON schema in `format` and thinking on.
  On the demo page it finds what axe cannot: invisible focus on 6 controls, the
  navigation vanishing at 320px, the *Seasonal pick* badge on a gradient, and the
  colour-only stock dots, plus a design review (scores, strengths, CSS suggestions)
- the vision findings' confidence — the model's own estimate combined with
  deterministic evidence: a focus finding where not one pixel changed is backed by the
  pixel diff; the badge's contrast is also *measured* (the same clip is captured with the
  text made transparent, and the text colour is blended over the real background pixels).
  A finding on an element axe or the probe already flagged for the same kind of rule is
  dropped (`deduplicated` in the report). Findings under 0.5 confidence are kept only in
  `suppressed`. Vision findings carry `source: "vision"`; DOM findings `source: "axe"`
  (the keyboard probe's too) with confidence 1.0. They are recorded for review, **not
  auto-patched**
- every database record, written through `db/mongo_store.py`
- the patch *recording* — done by Path 2's own `remediation/bridge/record_to_mongo.py`,
  invoked directly now that Path 2's harness lives in this repository

**The patch content — generated by a local model:**

Patches come from the local Ollama model `gemma4:26b` via
`pipeline/patch_llm.py`; patch records carry `model_used = "ollama:gemma4:26b"`.
Path 2's `locate.mjs` picks the file: `demo/index.html` for `button-name`,
`demo/script.js` (the dialog's keydown handler) for `keyboard-unreachable`.

**The six gates — all run on every patch, none asserted:**

| gate | what really runs | passes when |
|---|---|---|
| `diff-size` | Path 2's `guardDiff` via `pipeline/gates_cli.mjs guard` | ≤ 80 added, ≤ 40 removed lines, ≤ 2 files |
| `build` | **nothing — there is no build step** for this static HTML/JS site, so the gate is recorded `not-applicable`. The patched file's syntax check (`pipeline/patch_validate.py`) is the only compile-like check | syntax check passes (a syntax failure fails the gate) |
| `rescan` | axe-core **and** the keyboard probe over the patched page | the target violation is gone and no violation appears that was not in the baseline |
| `functional` | `integrity-check/check.js` over the patched page, with `--require-dialog-keyboard` for `keyboard-*` rules | exit 0 |
| `reviewer` | Path 2's model reviewer via `pipeline/gates_cli.mjs judge` against `gemma4:26b` on the local Ollama (`GUARDRAIL_JUDGE_URL`, `GUARDRAIL_JUDGE_MODEL`) | the reviewer ran and said `pass` |
| `visual` | the patched page is captured again and compared with the baseline capture, region by region and focus stop by focus stop. Pixel-identical → no model call. Changed regions are cropped to the change and re-checked by `guardrail-vision` with thinking **off** (seconds) | nothing changed, or the model saw no visual regression; new horizontal overflow, controls lost at 320px or a lost Tab stop fail on their own. `not-applicable` only with `--no-vision` |

Each gate is recorded as `passed`, `failed`, `unavailable` (it could not run — a
timeout, the model offline, a harness crash) or `not-applicable`. `unavailable`
is never a pass: with Ollama down the reviewer is `unavailable` and the run is
`NOT VERIFIED`. Every subprocess and model call has a timeout, so an offline
machine fails clearly instead of hanging. `verified` needs diff-size, rescan,
functional, reviewer and visual `passed` and build's syntax check ok. A vision
audit that could not run is recorded on the scan as `vision_audit.status:
"unavailable"` and logged in capitals — never as "no visual issues". Only then is the
patch recorded; the `verified` audit event's `details.gates` lists the gates that
passed, `details.gate_results` holds every gate's status, and
`details.gates_not_applicable` is `["build"]` (plus `"visual"` with `--no-vision`).

**By default the demo app is never modified.** The patch is applied to a copy under
`pipeline/runs/<timestamp>/verify/demo/`, so the planted violations stay in
`demo/` and the demo is repeatable (the watcher and the dashboard always run this
way). Only `--in-place` touches the real files, and only a verified patch stays (§1c).

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
