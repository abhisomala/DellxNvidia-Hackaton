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


MODEL_TIMEOUT_S = 300


def call_model(prompt: str) -> tuple[str, dict]:
    """POST the prompt to Ollama; return (response text, timing/token stats).

    Bounded by ``MODEL_TIMEOUT_S``: an offline or stuck model is a clear
    ``PatchGenerationError``, never a hang.
    """
    body = json.dumps({
        "model": MODEL, "prompt": prompt, "stream": False, "think": False,
        "options": {"temperature": 0.2, "num_predict": 1024},
    }).encode()
    url = f"{OLLAMA_URL}/api/generate"
    request = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=MODEL_TIMEOUT_S) as response:
            data = json.loads(response.read())
    except (OSError, ValueError) as exc:  # URLError, timeouts and bad JSON all land here
        raise PatchGenerationError(
            f"model call to {url} ({MODEL}) failed after {round(time.monotonic() - started, 1)}s "
            f"(timeout {MODEL_TIMEOUT_S}s): {exc}"
        ) from exc
    stats = {
        "latency_s": round(time.monotonic() - started, 2),
        "eval_count": data.get("eval_count"),
        "prompt_eval_count": data.get("prompt_eval_count"),
        "load_duration_s": round((data.get("load_duration") or 0) / 1e9, 2),
        "total_duration_s": round((data.get("total_duration") or 0) / 1e9, 2),
    }
    return data.get("response") or "", stats


def _repo_relative(path: Path, repo_root: Path) -> str:
    try:
        return str(path.relative_to(repo_root.resolve()))
    except ValueError:
        return str(path)


def build_patch(violation: dict, source_text: str | None = None, *, repo_root: Path = REPO_ROOT) -> dict:
    """Generate, splice, validate and diff a model-authored patch for ``violation``.

    The file patched is the one ``locate.mjs`` found, which for keyboard rules is
    the script rather than the scanned page.  ``source_text`` is used only when
    it belongs to that located file; otherwise the located file is read here.
    ``result['source_file']`` is the located file, repo-relative.
    """
    location = locate_violation(violation, repo_root)
    if not location.get("file"):
        raise PatchGenerationError(f"locate.mjs returned no file for {violation.get('rule_id')}")
    app_root = repo_root / Path(violation["source_file"]).parent
    located = (app_root / location["file"]).resolve()
    if not located.is_file():
        raise PatchGenerationError(f"located source {located} does not exist")
    source_file = _repo_relative(located, repo_root)
    scanned = (repo_root / violation["source_file"]).resolve()
    if source_text is None or scanned != located:
        source_text = located.read_text()

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
        "scanned_file": violation["source_file"],
        "line": location.get("line") or start,
        "original_snippet": original.strip(),
        "patched_snippet": replacement.strip(),
        "original_text": source_text,
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
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        result, code = build_patch(violation), 0
    except PatchGenerationError as exc:
        result, code = exc.result, 1
        print(f"PATCH FAILED: {exc}", file=sys.stderr)

    print(f"rule:    {args.rule} ({MODEL}) -> {result.get('source_file')}")
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
