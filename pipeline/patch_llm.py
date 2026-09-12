"""Real patch generator: asks a local Ollama model (gemma4:26b) to fix one violation.

Flow: locate the element in source -> pick an edit region -> build a prompt ->
call the model -> extract its code block -> splice it over the region ->
validate the whole patched file -> unified diff.  No retries: a bad answer
raises ``PatchGenerationError`` so the pipeline fails loudly.
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from pipeline.patch_parse import extract_code  # noqa: E402
from pipeline.patch_prompt import build_prompt, edit_region, locate_violation  # noqa: E402
from pipeline.patch_validate import validate  # noqa: E402

MODEL = os.environ.get("GUARDRAIL_PATCH_MODEL", "gemma4:26b")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
STAGED = REPO_ROOT / "pipeline" / "staged_violations.json"
DEFAULT_OUT = REPO_ROOT / "pipeline" / "runs" / "patch-tests"


class PatchGenerationError(RuntimeError):
    """The model's answer could not be turned into a valid, non-empty patch."""

    def __init__(self, message: str, result: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.result = result or {}


def call_model(prompt: str) -> tuple[str, dict]:
    """POST the prompt to Ollama; return (response text, timing/token stats)."""
    body = json.dumps({
        "model": MODEL, "prompt": prompt, "stream": False, "think": False,
        "options": {"temperature": 0.2, "num_predict": 1024},
    }).encode()
    request = urllib.request.Request(
        f"{OLLAMA_URL}/api/generate", data=body, headers={"Content-Type": "application/json"}
    )
    started = time.monotonic()
    with urllib.request.urlopen(request, timeout=600) as response:
        data = json.loads(response.read())
    stats = {
        "latency_s": round(time.monotonic() - started, 2),
        "eval_count": data.get("eval_count"),
        "prompt_eval_count": data.get("prompt_eval_count"),
        "load_duration_s": round((data.get("load_duration") or 0) / 1e9, 2),
        "total_duration_s": round((data.get("total_duration") or 0) / 1e9, 2),
    }
    return data.get("response") or "", stats


def build_patch(violation: dict, source_text: str, *, repo_root: Path = REPO_ROOT) -> dict:
    """Generate, splice, validate and diff a model-authored patch for ``violation``."""
    source_file = violation["source_file"]
    location = locate_violation(violation, repo_root)
    start, end = edit_region(source_text, location.get("line"))
    prompt = build_prompt(violation, source_file, source_text, (start, end))
    raw, stats = call_model(prompt)

    lines = source_text.splitlines(keepends=True)
    original = "".join(lines[start - 1:end])
    replacement = extract_code(raw)
    if original.endswith("\n") and not replacement.endswith("\n"):
        replacement += "\n"
    patched_lines = lines[:start - 1] + replacement.splitlines(keepends=True) + lines[end:]
    patched_text = "".join(patched_lines)
    valid, error = validate(Path(source_file).name, patched_text)

    result = {
        "rule_id": violation["rule_id"],
        "selector": violation.get("selector", ""),
        "source_file": source_file,
        "line": location.get("line") or start,
        "original_snippet": original.strip(),
        "patched_snippet": replacement.strip(),
        "patched_text": patched_text,
        "patch_diff": "".join(difflib.unified_diff(
            lines, patched_lines, fromfile=f"a/{source_file}", tofile=f"b/{source_file}", n=3,
        )),
        "model_used": f"ollama:{MODEL}",
        "prompt": prompt,
        "raw_response": raw,
        "latency_s": stats["latency_s"],
        "stats": stats,
        "region": [start, end],
        "location_method": location.get("method"),
        "valid": valid,
        "validation_error": error,
    }
    if not valid:
        raise PatchGenerationError(f"patched {source_file} failed validation: {error}", result)
    if patched_text == source_text:
        result["valid"], result["validation_error"] = False, "patch is identical to the original"
        raise PatchGenerationError("model returned the region unchanged", result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rule", required=True, help="rule_id key in staged_violations.json")
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args()

    violation = json.loads(STAGED.read_text())[args.rule]
    source_text = (REPO_ROOT / violation["source_file"]).read_text()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        result, code = build_patch(violation, source_text), 0
    except PatchGenerationError as exc:
        result, code = exc.result, 1
        print(f"PATCH FAILED: {exc}", file=sys.stderr)

    print(f"rule:    {args.rule} ({MODEL})")
    print(f"latency: {result.get('latency_s')}s  region: {result.get('region')}  "
          f"method: {result.get('location_method')}")
    print(f"valid:   {result.get('valid')} {result.get('validation_error') or ''}")
    if code:
        print("--- raw response ---\n" + (result.get("raw_response") or ""))
    else:
        print("--- patched snippet ---\n" + result["patched_snippet"])
        print("--- diff ---\n" + result["patch_diff"])
    out_path = out_dir / f"patch-{args.rule}.json"
    out_path.write_text(json.dumps(result, indent=2))
    print(f"wrote {out_path}")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
