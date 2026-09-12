#!/usr/bin/env bash
# Builds the guardrail-vision model from vision/Modelfile after confirming the base model
# really has the vision and tools capabilities (`ollama list` does not print capabilities;
# `ollama show` does). Exit 0 = model ready, 1 = base model missing or lacks a capability.
set -euo pipefail
cd "$(dirname "$0")"
BASE=gemma4:26b
NAME=${GUARDRAIL_VISION_MODEL:-guardrail-vision}

# Read whole outputs first: grep -q closing a pipe early is SIGPIPE under pipefail.
models=$(ollama list | awk 'NR > 1 { print $1 }')
if ! grep -qx "$BASE" <<<"$models"; then
  echo "base model $BASE is not pulled: run 'ollama pull $BASE'" >&2
  exit 1
fi
shown=$(ollama show "$BASE")
capabilities=$(awk '/Capabilities/ { on = 1; next } on && NF == 0 { exit } on { print $1 }' <<<"$shown")
echo "$BASE capabilities: $(echo "$capabilities" | tr '\n' ' ')"
for needed in vision tools thinking; do
  if ! grep -qx "$needed" <<<"$capabilities"; then
    echo "$BASE lacks the '$needed' capability; the vision judge needs it" >&2
    exit 1
  fi
done

ollama create "$NAME" -f Modelfile
echo
ollama show "$NAME" --parameters
echo "$NAME is ready (FROM $BASE, num_ctx pinned)."
