#!/usr/bin/env bash
# Proves the GuardRail reviewer gate (pipeline/gates_cli.mjs judge) FAILS CLOSED.
#
#   bash pipeline/tests/reviewer_fail_closed.sh
#
# Runs the gate against a misbehaving stub reviewer (every mode of judge_stub_server.mjs), an
# unreachable endpoint, an empty judge_url, and the real local Ollama reviewer with a good and a
# destructive diff for the demo's button-name violation.
#
# Only the 'pass' stub must approve; the real good diff is informational (it depends on the
# model agreeing). Every other case must come back ok:false.
#
# Exit: 0 all expectations met | 1 a fail-open case returned ok:true | 3 harness problem
# (gate did not exit 0, the pass stub was not approved, or the stub never saw the request).
set -u
cd "$(dirname "$0")/../.." || exit 3
REPO=$(pwd)
GATES="$REPO/pipeline/gates_cli.mjs"
STUB="$REPO/pipeline/tests/judge_stub_server.mjs"
# Fixtures come from the committed page, so the test still works after a patch has been applied in place.
DEMO="${REVIEWER_TEST_PAGE:-$(mktemp --suffix=.html)}"
[ -s "$DEMO" ] || git -C "$REPO" show HEAD:demo/index.html > "$DEMO"
OLLAMA_URL=${OLLAMA_URL:-http://127.0.0.1:11434/v1}
OLLAMA_MODEL=${OLLAMA_MODEL:-gemma4:26b}
STUB_LIMIT=30      # seconds per stub/unreachable/empty call
REAL_LIMIT=240     # seconds per real-model call (judge() itself aborts after 180 s)

WORK=$(mktemp -d)
STUB_PID=""
cleanup() { if [ -n "$STUB_PID" ]; then kill "$STUB_PID" 2>/dev/null; fi; rm -rf "$WORK"; }
trap cleanup EXIT

fail_open=0
harness=0

# ---- fixtures: the real demo button-name violation, a minimal fix, and a destructive "fix" ----
if ! timeout 20 node - "$DEMO" "$WORK" <<'EOF'
const fs = require('node:fs');
const [demo, work] = process.argv.slice(2);
const src = fs.readFileSync(demo, 'utf8');
const bag = '<button class="bag-button" type="button" data-open-modal></button>';
const close = /^[ \t]*<button class="modal-close" type="button" data-close-modal>Close<\/button>\r?\n/m;
const once = (s, what) => { if (s.split(what).length !== 2) { console.error(`fixture: expected exactly one ${what} in ${demo}`); process.exit(1); } };
once(src, bag);
if (!close.test(src)) { console.error(`fixture: Close button line not found in ${demo}`); process.exit(1); }
fs.writeFileSync(`${work}/good.html`, src.replace(bag, '<button class="bag-button" type="button" aria-label="Open shopping bag" data-open-modal></button>'));
fs.writeFileSync(`${work}/bad.html`, src.replace(bag, '<button class="bag-button" type="button" aria-label="Open shopping bag"></button>').replace(close, ''));
fs.writeFileSync(`${work}/violation.json`, JSON.stringify({
  rule_id: 'button-name',
  description: 'Ensures buttons have discernible text',
  selector: '.bag-button',
  html: bag,
}));
EOF
then echo "HARNESS: could not build fixtures from $DEMO"; exit 3; fi
for kind in good bad; do
  diff -u --label a/demo/index.html --label b/demo/index.html "$DEMO" "$WORK/$kind.html" > "$WORK/$kind.diff"
  if [ $? -ne 1 ]; then echo "HARNESS: $kind diff is empty or diff failed"; exit 3; fi
done

echo "================================================================"
echo " reviewer gate fail-closed check"
echo " gate: $GATES"
echo "================================================================"
echo "--- good diff (minimal button-name fix) ---"; cat "$WORK/good.diff"
echo "--- bad diff (drops data-open-modal and the Close button) ---"; cat "$WORK/bad.diff"
echo

# run_case <label> <expect: reject|pass|info> <judge_url> <judge_model> <reasoning_effort> <diff file> <time limit s>
# Sets LAST_OK to true|false.
run_case() {
  local label=$1 expect=$2 url=$3 model=$4 effort=$5 diff=$6 limit=$7
  local req out code parsed ok summary verdict
  req=$(REQ_URL=$url REQ_MODEL=$model REQ_EFFORT=$effort REQ_DIFF=$diff REQ_VIOLATION="$WORK/violation.json" timeout 20 node -e '
    const fs = require("node:fs"), e = process.env;
    const r = { violation: JSON.parse(fs.readFileSync(e.REQ_VIOLATION, "utf8")), diff: fs.readFileSync(e.REQ_DIFF, "utf8"), judge_url: e.REQ_URL, judge_model: e.REQ_MODEL };
    if (e.REQ_EFFORT) r.reasoning_effort = e.REQ_EFFORT;
    process.stdout.write(JSON.stringify(r));')
  local t0=$SECONDS
  out=$(printf '%s' "$req" | timeout "$limit" node "$GATES" judge 2>"$WORK/gates.err")
  code=$?
  parsed=$(printf '%s' "$out" | timeout 20 node -e '
    let s = ""; process.stdin.on("data", (c) => s += c).on("end", () => {
      let r; try { r = JSON.parse(s); } catch { console.log("false\t" + JSON.stringify({ unparseable_stdout: s.slice(0, 300) })); return; }
      console.log((r.ok === true) + "\t" + JSON.stringify({ ok: r.ok, status: r.status, reasons: r.reasons }));
    });')
  IFS=$'\t' read -r ok summary <<< "$parsed"
  ok=${ok:-false}
  LAST_OK=$ok

  case "$expect" in
    reject)
      if [ "$ok" = true ]; then verdict="FAIL-OPEN: approved but must be rejected"; fail_open=$((fail_open + 1))
      elif [ "$code" -ne 0 ]; then verdict="rejected, but gate exit $code (expected 0: a verdict)"; harness=$((harness + 1))
      else verdict="rejected (expected)"; fi ;;
    pass)
      if [ "$ok" = true ] && [ "$code" -eq 0 ]; then verdict="approved (expected)"
      else verdict="UNEXPECTED: must be approved (exit $code)"; harness=$((harness + 1)); fi ;;
    info)
      if [ "$ok" = true ]; then verdict="approved (informational: the model agreed)"
      else verdict="rejected (informational: the model did not approve, or was unavailable; exit $code)"; fi ;;
  esac
  printf '%-34s exit=%s %ss  %s\n' "$label" "$code" "$((SECONDS - t0))" "$verdict"
  printf '    %s\n' "$summary"
  if [ "$code" -ne 0 ]; then sed 's/^/    stderr: /' "$WORK/gates.err" | tail -3; fi
}

start_stub() {
  coproc STUBP { exec node "$STUB" 0 "$1" 2>"$WORK/stub.log"; }
  STUB_PID=$STUBP_PID
  local line=""
  if ! read -t 10 -r line <&"${STUBP[0]}" || [ "${line%% *}" != listening ]; then
    echo "HARNESS: stub ($1) did not start: $(cat "$WORK/stub.log")"; return 1
  fi
  STUB_PORT=${line#listening }
}
stop_stub() { kill "$STUB_PID" 2>/dev/null; wait "$STUB_PID" 2>/dev/null; STUB_PID=""; }

echo "---------------- stub reviewer modes ----------------"
for mode in badjson brokenjson badverdict http500 nocontent fail pass; do
  if ! start_stub "$mode"; then harness=$((harness + 1)); continue; fi
  expect=reject; [ "$mode" = pass ] && expect=pass
  run_case "stub:$mode" "$expect" "http://127.0.0.1:$STUB_PORT/v1" stub-model none "$WORK/good.diff" "$STUB_LIMIT"
  stop_stub
  if grep -q 'POST /v1/chat/completions' "$WORK/stub.log"; then
    printf '    stub saw: %s\n' "$(grep -m1 'POST' "$WORK/stub.log")"
  else
    echo "    HARNESS: the stub never received the review request"; harness=$((harness + 1))
  fi
done
echo

echo "---------------- no reviewer ----------------"
run_case "unreachable http://127.0.0.1:9/v1" reject "http://127.0.0.1:9/v1" stub-model none "$WORK/good.diff" "$STUB_LIMIT"
run_case "empty judge_url" reject "" "$OLLAMA_MODEL" none "$WORK/good.diff" "$STUB_LIMIT"
echo

echo "---------------- real reviewer: $OLLAMA_MODEL @ $OLLAMA_URL ----------------"
if tags=$(curl -s --max-time 5 "${OLLAMA_URL%/v1}/api/tags"); then
  if printf '%s' "$tags" | grep -q "\"$OLLAMA_MODEL\""; then echo "ollama reachable, $OLLAMA_MODEL installed"
  else echo "ollama reachable, but $OLLAMA_MODEL is not listed (the calls below must then be rejected)"; fi
else
  echo "ollama NOT reachable (the calls below must then be rejected as unavailable)"
fi
run_case "real:good-diff" info "$OLLAMA_URL" "$OLLAMA_MODEL" none "$WORK/good.diff" "$REAL_LIMIT"
run_case "real:bad-diff" reject "$OLLAMA_URL" "$OLLAMA_MODEL" none "$WORK/bad.diff" "$REAL_LIMIT"
echo

echo "================================================================"
printf ' fail-open cases: %s   harness problems: %s\n' "$fail_open" "$harness"
echo "================================================================"
if [ "$fail_open" -gt 0 ]; then echo "RESULT: FAIL - the reviewer gate failed OPEN"; exit 1; fi
if [ "$harness" -gt 0 ]; then echo "RESULT: FAIL - harness problem (see above)"; exit 3; fi
echo "RESULT: PASS - the reviewer gate failed closed in every case"
exit 0
