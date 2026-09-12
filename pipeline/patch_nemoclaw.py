"""Optional patch transport: send the patch prompt to the OpenClaw agent in a NemoClaw sandbox.

Selected by ``GUARDRAIL_PATCH_BACKEND=nemoclaw`` (see ``patch_llm.call_model``); the
default backend stays a direct Ollama call.  The agent runs inside an OpenShell
sandbox (deny-by-default egress, logged turns) and its model calls are routed by
OpenShell to the host's Ollama, so the model is still gemma4:26b.

The prompt is the one ``patch_prompt.build_prompt`` already builds, with the source
region inline, so the agent needs no file access: it answers with a code block and
``patch_llm`` splices, validates and diffs it exactly as for the direct backend.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
import uuid

SANDBOX = os.environ.get("GUARDRAIL_NEMOCLAW_SANDBOX", "guardrail")
NEMOCLAW_BIN = os.environ.get("GUARDRAIL_NEMOCLAW_BIN", "nemoclaw")
TIMEOUT_S = int(os.environ.get("GUARDRAIL_NEMOCLAW_TIMEOUT_S", "300"))

ANSWER_ONLY = (
    "Answer with the replacement code only, as a single fenced code block. "
    "Do not read, write or run anything; do not use tools.\n\n"
)


class NemoClawError(RuntimeError):
    """The sandboxed agent turn failed or returned no usable reply."""


def extract_envelope(stdout: str) -> dict | None:
    """OpenClaw's ``--json`` envelope: the whole stdout, else the last JSON object in it.

    Mirrors ``extractEnvelope`` in remediation/src/lib/agent.mjs.
    """
    s = stdout.strip()
    candidates = [s]
    idx = s.rfind("\n{")
    if idx >= 0:
        candidates.append(s[idx + 1:])
    brace = s.find("{")
    if brace >= 0:
        candidates.append(s[brace:])
    for candidate in candidates:
        try:
            value = json.loads(candidate)
        except ValueError:
            continue
        if isinstance(value, dict):
            return value
    return None


def _tail(text: str, lines: int = 8) -> str:
    return "\n".join((text or "").strip().splitlines()[-lines:])


def call_nemoclaw(prompt: str, timeout_s: int = TIMEOUT_S) -> tuple[str, dict]:
    """One fresh agent turn in the sandbox; return (reply text, timing stats)."""
    argv = [
        NEMOCLAW_BIN, SANDBOX, "agent", "--agent", "main",
        "--session-key", f"guardrail-{uuid.uuid4().hex[:12]}",
        "--json", "--timeout", str(timeout_s), "-m", ANSWER_ONLY + prompt,
    ]
    where = f"{NEMOCLAW_BIN} {SANDBOX} agent"
    started = time.monotonic()
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=timeout_s + 60)
    except FileNotFoundError as exc:
        raise NemoClawError(f"{NEMOCLAW_BIN} not found on PATH: {exc}") from exc
    except subprocess.TimeoutExpired as exc:
        raise NemoClawError(f"{where} timed out after {timeout_s + 60}s") from exc
    latency = round(time.monotonic() - started, 2)
    if proc.returncode != 0:
        raise NemoClawError(f"{where} exited {proc.returncode} after {latency}s: {_tail(proc.stderr or proc.stdout)}")
    envelope = extract_envelope(proc.stdout)
    if envelope is None:
        raise NemoClawError(f"{where} printed no JSON envelope: {_tail(proc.stdout or proc.stderr)}")
    if envelope.get("ok") is False:
        raise NemoClawError(f"{where} reported ok:false: {_tail(json.dumps(envelope))}")
    final = envelope.get("final")
    if final is None:
        final = "\n".join(p.get("text") or "" for p in envelope.get("payloads") or [] if isinstance(p, dict))
    if not (final or "").strip():
        # an empty reply would splice as "delete the edit region", which can still validate
        raise NemoClawError(f"{where} returned an empty reply: {_tail(json.dumps(envelope))}")
    usage = envelope.get("usage") if isinstance(envelope.get("usage"), dict) else {}
    stats = {
        "latency_s": latency,
        "eval_count": usage.get("output_tokens") or usage.get("completion_tokens"),
        "prompt_eval_count": usage.get("input_tokens") or usage.get("prompt_tokens"),
        "load_duration_s": None,
        "total_duration_s": latency,
        "sandbox": SANDBOX,
    }
    return final, stats
