#!/usr/bin/env bash
# Read-only preflight for the optional NemoClaw/OpenShell patch backend (GUARDRAIL_PATCH_BACKEND=nemoclaw).
#
#   bash scripts/nemoclaw-check.sh            # sandbox name from GUARDRAIL_NEMOCLAW_SANDBOX, default guardrail
#
# Stops at the first failing check. Exit: 0 ready | 1 a check failed.
set -u
SANDBOX=${GUARDRAIL_NEMOCLAW_SANDBOX:-guardrail}
NEMOCLAW=${GUARDRAIL_NEMOCLAW_BIN:-nemoclaw}
MODEL=${GUARDRAIL_PATCH_MODEL:-gemma4:26b}

step() { printf '\n== %s\n' "$*"; }
die() { printf 'FAIL: %s\n' "$*"; exit 1; }

step "CLIs on PATH"
command -v "$NEMOCLAW" || die "$NEMOCLAW not on PATH (install: see DEMO.md, Optional: patches through NemoClaw)"
command -v openshell || die "openshell not on PATH"
docker ps >/dev/null 2>&1 || die "docker is not usable by $(id -un) (add the user to the docker group, then log in again)"

step "Ollama serves $MODEL and is reachable from containers (not only 127.0.0.1)"
curl -fsS --max-time 5 http://127.0.0.1:11434/api/tags | grep -q "\"$MODEL\"" || die "ollama does not list $MODEL"
ss -ltn | grep -qE '(0\.0\.0\.0|\*|\[::\]):11434\b' || die "ollama listens on 127.0.0.1 only; set OLLAMA_HOST=0.0.0.0:11434 (DEMO.md)"

step "sandbox $SANDBOX status"
"$NEMOCLAW" "$SANDBOX" status || die "nemoclaw $SANDBOX status failed"

step "sandbox $SANDBOX doctor"
"$NEMOCLAW" "$SANDBOX" doctor || die "nemoclaw $SANDBOX doctor failed"

step "OpenShell network policy for $SANDBOX"
"$NEMOCLAW" "$SANDBOX" policy list || die "nemoclaw $SANDBOX policy list failed"

step "smoke agent turn (inference routed to Ollama)"
out=$("$NEMOCLAW" "$SANDBOX" agent --agent main --session-key "preflight-$$" --json --timeout 240 -m "Reply with the single word OK." 2>&1) \
  || die "agent turn failed: $(printf '%s' "$out" | tail -5)"
printf '%s\n' "$out" | tail -5
printf '%s' "$out" | grep -q '"ok"[[:space:]]*:[[:space:]]*false' && die "agent envelope reported ok:false"
printf '%s' "$out" | grep -qi 'ok' || die "agent reply did not contain OK"

printf '\nREADY: GUARDRAIL_PATCH_BACKEND=nemoclaw will send patch prompts to sandbox %s\n' "$SANDBOX"
