# Path 2: remediation harness (`a11y-fix`)

One violation JSON in, one verified patch out. The harness does not write the fix itself: it drives an
**OpenClaw agent** (the same runtime NemoClaw runs inside its OpenShell sandbox) and treats the agent as an
untrusted engineer whose work is checked by build, rescan, and a functional test, with feedback retries.

```
violation.json ──► locate source file/line ──► prompt OpenClaw agent (edits the file with its own tools)
                                                         │
        ┌────────────────────────────────────────────────┘
        ▼
   build ──► rescan (Path 1 scanner: rule_id+selector gone, nothing new) ──► functional check (button still clicks, form still submits)
        │ any failure: feed diff + failure back to the agent, retry (max --max-attempts)
        ▼
   out/<id>/patch.diff + report.json
```

## Input: raw axe-core output works directly

The fixer accepts **raw `axe.run()` results** (the `AxeResults` object, an array of axe `Result`s, or a single `Result`)
as well as the schema-1.0 document below. Each axe `Result` x `NodeResult` pair becomes one violation with id
`<rule>#<nodeIndex>`; pick one with `--id button-name#0`, `--id button-name` (first node) or `--id '#upload-submit'`.
The rescan (gate 3) normalizes the scanner's output the same way, so an axe-only scanner needs no wrapper:

```bash
node fixtures/scanner/axe-raw.mjs --url http://127.0.0.1:5174/ > raw.json        # exact axe.run() JSON
node src/fix.mjs --scan raw.json --id label --scan-cmd 'node fixtures/scanner/axe-raw.mjs --url {url}'
```

## Input: the team's MongoDB `scans` shape works too

A `scans` document from `db/mongo_store.py` (`{ target_app, timestamp, violations: [{ rule_id, selector, severity,
description, source_file, ... }] }`) or one of its violation dictionaries is accepted as-is: `severity` maps to impact,
`source_file` becomes the source hint (so localization is skipped), extra keys pass through. Every fix report carries a
`mongo_patch` record in the `patches` shape (`violation_rule_id`, `source_file`, `original_snippet`, `patched_snippet`,
`model_used`, `verified`, plus `scan_id` when the input came from MongoDB), and the bridge writes it through the
teammate's own module (no schema duplicated here):

```bash
python3 bridge/record_to_mongo.py out/button-name_0/report.json --dry-run    # print the patches + audit_log documents
MONGODB_URI=mongodb://localhost:27017 python3 bridge/record_to_mongo.py out/button-name_0/report.json   # insert via db.mongo_store
```

Exit 0 = recorded, 2 = MongoDB unavailable (nothing written), 1 = bad input. Needs `pymongo` (see `db/requirements.txt`).

## The five gates (in order; any failure feeds back to the agent and retries)

1. **Diff guard** (deterministic): at most `--max-added-lines` (80) added, `--max-removed-lines` (40) removed, `--max-files` (2) touched.
2. **Build**: the app's production build must succeed (`--build-cmd`).
3. **Rescan**: the scanner runs again; the target `rule_id`+`selector` must be gone and no pair absent from the baseline may appear.
4. **Functional check**: `--func-cmd` must exit 0 (buttons still click, forms still submit).
5. **Reviewer**: a tool-less model call over the diff (`--judge-url`/`--judge-model`, OpenAI-compatible) rejects removed elements, duplicated/unreachable code, hidden or unwired controls.

## Handoff contract (Path 1 → Path 2)

`schema/violations.schema.json`, examples in `examples/`. A violation is identified by `rule_id` + `selector`.
The scanner is any command that prints that JSON to stdout (`--scan-cmd`); the functional check is any command
that exits non-zero when behavior broke (`--func-cmd`). Both are injected, so the teammate's real scanner and app
replace the stand-ins in `fixtures/scanner` and `fixtures/demo-app` without code changes.

## Which model is used

None is set on this branch. By default the harness runs `openclaw agent --agent main` and sends no `--model`, so the
agent uses whatever its own OpenClaw configuration says. In the NemoClaw sandbox that is NemoClaw's managed model
behind `inference.local`; nothing here has to change on merge or deploy. The reviewer (gate 5) is off unless an
OpenAI-compatible endpoint is given (`--judge-url`/`--judge-model`, or `A11Y_JUDGE_URL`/`A11Y_JUDGE_MODEL`,
or `OPENAI_BASE_URL`/`OPENAI_MODEL`); in the sandbox point it at the same local route.

Backends (`--agent-backend`, or `A11Y_AGENT_BACKEND`):
- `openclaw` (default): the installed OpenClaw agent on this machine, with its configured model.
- `nemoclaw`: from the host, `nemoclaw <sandbox> agent --agent main ...` into the sandbox (needs `--sandbox`).
- `local`: development only; an embedded agent with its own state dir, and you must pass `--model` (or `A11Y_LOCAL_MODEL`).

## Run locally (laptop, development)

```bash
cd remediation && npm install                 # self-contained: pins openclaw 2026.7.1 + a local node 24, playwright, axe-core, vite/react for the fixture app
ollama pull qwen3:8b                          # local stand-in for the GB10's Qwen3.6-35B-A3B
npm run app &                                 # fixture demo app on http://127.0.0.1:5174/
export A11Y_BROWSER_CHANNEL=chrome            # use installed Chrome (or A11Y_CHROMIUM_PATH=/usr/bin/chromium on Linux; or `npm run browser:install`)

npm run scan -- --url http://127.0.0.1:5174/ --out scan.json      # stand-in scanner (axe + keyboard-trap probe)
npm run scan:raw -- --url http://127.0.0.1:5174/ > raw.json       # or exact axe.run() JSON
export A11Y_AGENT_BACKEND=local A11Y_LOCAL_MODEL=ollama/qwen3:8b   # dev-only: embedded agent + a local model of your choice
export A11Y_JUDGE_URL=http://127.0.0.1:11434/v1 A11Y_JUDGE_MODEL=qwen3:8b   # optional reviewer for dev
node src/fix.mjs --scan raw.json --id button-name                  # fix one violation (defaults: fixture app, fixture scanner)
node src/fix.mjs --violation examples/label.json                   # or from a bare violation object
node src/bench.mjs --runs 3 --thinking off                         # every violation x 3
```
All paths default to the fixtures inside this directory, so the commands work from any working directory.

The local backend runs `openclaw agent --local` under `bin/openclaw` (the pinned build on a project-local Node 24)
with its own state dir (`.state`, config template `config/openclaw.local.json`, model injected from `--model`), so it
never touches `~/.openclaw`.

## Run on the GB10 (NemoClaw sandbox)

The app checkout lives inside the sandbox (for example `/sandbox/.openclaw/workspace/demo-app`), its dev server
runs inside the sandbox on 127.0.0.1:5174 and is forwarded to the host (`openshell forward start 5174 <sandbox>`),
and the scanner runs on the host against the forwarded port. The harness then drives the sandboxed agent and
runs git/build inside the sandbox:

```bash
# inside the sandbox (default backend; the agent's configured model is used):
node src/fix.mjs --violation v.json --app-root /sandbox/.openclaw/workspace/demo-app --url http://127.0.0.1:5174/ \
  --scan-cmd '<scanner command> --url {url}' --func-cmd '<functional check> --url {url}' --build-cmd ''
# or from the host, driving the sandboxed agent:
node src/fix.mjs --violation v.json \
  --agent-backend nemoclaw --exec-backend nemoclaw --sandbox my-assistant \
  --remote-app-root /sandbox/.openclaw/workspace/demo-app \
  --url http://127.0.0.1:5174/ \
  --build-cmd 'npm run build --silent' \
  --scan-cmd '<teammate scanner command> --url {url}' --func-cmd '<teammate functional check> --url {url}'
```

`--agent-backend nemoclaw` sends each turn as `nemoclaw <sandbox> agent --agent main --json -m "..."`, which
NemoClaw forwards verbatim to `openclaw agent` inside the sandbox. `--agent-backend openclaw` targets a gateway on
the host instead (`openclaw agent --agent main`), for the case where the sandbox wiring is faked.

## Layout

- `src/fix.mjs` – entry point and the fix loop (`fixOne` is reusable)
- `src/bench.mjs` – N runs per violation, writes `out/bench-*.md|json`
- `src/lib/locate.mjs` – selector/id/class/text → source file and line (uses `violation.source` when Path 1 provides it)
- `src/lib/prompt.mjs` – the agent prompt (initial + retry with diff and failures); rule hints in `rules/guidance.json`
- `src/lib/agent.mjs` – one agent turn via local embedded / nemoclaw / gateway backends
- `src/lib/verify.mjs` – build → rescan diff → functional check
- `src/lib/app.mjs` – git diff/restore and command execution, locally or inside the sandbox
- `src/lib/normalize.mjs` – raw axe-core results → internal violation list
- `fixtures/demo-app` – React portal with three staged violations (button-name, label, keyboard-trap)
- `fixtures/scanner` – stand-in scanner (`scan.mjs`), raw axe emitter (`axe-raw.mjs`), functional check (`functional.mjs`)
- `bridge/record_to_mongo.py` – records a finished fix in the team MongoDB via `db.mongo_store`
- `docs/` – bench results

## Outputs

`out/<violation id>/`: `prompt-N.md`, `agent-reply-N.md`, `patch.diff` (unified diff, `git apply`-able), `report.json`
(status, attempts, verification results, timings). Exit code 0 = verified fix, 1 = failed after retries, 3 = violation not present.
