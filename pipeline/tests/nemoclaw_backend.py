"""Checks the optional NemoClaw patch backend without a sandbox, using a fake ``nemoclaw`` CLI.

    python3 pipeline/tests/nemoclaw_backend.py            # stub cases only
    python3 pipeline/tests/nemoclaw_backend.py --real     # also one turn through the real sandbox

The fake CLI records its argv and prints whatever reply the case prepared.  Every
broken reply must surface as ``PatchGenerationError``; a good reply must produce a
valid patch whose ``model_used`` names the sandbox.  The default backend is checked
to still be the direct Ollama call.

Exit: 0 all cases passed | 1 a case failed.
"""

from __future__ import annotations

import json
import os
import stat
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from pipeline import patch_llm, patch_nemoclaw  # noqa: E402
from pipeline.patch_llm import PatchGenerationError, build_patch  # noqa: E402
from pipeline.patch_prompt import edit_region, locate_violation  # noqa: E402

STUB = """#!/usr/bin/env bash
printf '%s\\n' "$@" > "$STUB_DIR/argv"
cat "$STUB_DIR/stdout"
cat "$STUB_DIR/stderr" >&2
exit "$(cat "$STUB_DIR/code")"
"""

failures = 0


def check(label: str, ok: bool, detail: str = "") -> None:
    global failures
    print(f"{'PASS' if ok else 'FAIL'}  {label}{'  -- ' + detail if detail and not ok else ''}")
    failures += 0 if ok else 1


def good_reply(violation: dict) -> str:
    """The real button-name region with an aria-label added, as the model would return it."""
    location = locate_violation(violation, REPO_ROOT)
    source = (REPO_ROOT / violation["source_file"]).parent / location["file"]
    lines = source.read_text().splitlines(keepends=True)
    start, end = edit_region("".join(lines), location.get("line"))
    region = "".join(lines[start - 1:end])
    fixed = region.replace('class="bag-button"', 'class="bag-button" aria-label="Open shopping bag"', 1)
    assert fixed != region, "fixture: bag-button not inside the edit region"
    return f"Here is the fix:\n\n```html\n{fixed}```\n"


def main() -> int:
    violation = json.loads((REPO_ROOT / "pipeline" / "staged_violations.json").read_text())["button-name"]
    work = Path(tempfile.mkdtemp(prefix="nemoclaw-stub-"))
    stub = work / "nemoclaw"
    stub.write_text(STUB)
    stub.chmod(stub.stat().st_mode | stat.S_IXUSR)
    os.environ["STUB_DIR"] = str(work)

    def arrange(stdout: str, code: int = 0, stderr: str = "") -> None:
        (work / "stdout").write_text(stdout)
        (work / "stderr").write_text(stderr)
        (work / "code").write_text(str(code))

    check("default backend is ollama", patch_llm.BACKEND == "ollama" or "GUARDRAIL_PATCH_BACKEND" in os.environ)

    patch_llm.BACKEND = "nemoclaw"
    patch_nemoclaw.NEMOCLAW_BIN = str(stub)
    reply = good_reply(violation)

    # 1. a good envelope -> a valid patch attributed to the sandbox
    arrange(json.dumps({"ok": True, "status": "done", "final": reply}))
    try:
        result = build_patch(violation, repo_root=REPO_ROOT)
        check("good envelope -> valid patch", result["valid"] and 'aria-label="Open shopping bag"' in result["patch_diff"])
        check("model_used names the sandbox", result["model_used"] == f"nemoclaw:{patch_nemoclaw.SANDBOX}/ollama:{patch_llm.MODEL}",
              result["model_used"])
        argv = (work / "argv").read_text().splitlines()
        check("argv is `<sandbox> agent --agent main ... --json -m`",
              argv[:4] == [patch_nemoclaw.SANDBOX, "agent", "--agent", "main"] and "--json" in argv and "-m" in argv, str(argv[:8]))
    except PatchGenerationError as exc:
        check("good envelope -> valid patch", False, str(exc))

    # 2. payloads[] instead of final, after log noise on stdout
    arrange("[openclaw] booting\n" + json.dumps({"ok": True, "payloads": [{"text": reply}]}))
    try:
        check("payloads envelope after log lines -> valid patch", build_patch(violation, repo_root=REPO_ROOT)["valid"])
    except PatchGenerationError as exc:
        check("payloads envelope after log lines -> valid patch", False, str(exc))

    # 3-6. every broken reply fails loudly
    broken = {
        "non-zero exit": (dict(stdout="", code=1, stderr="sandbox guardrail is not running"), "not running"),
        "no JSON envelope": (dict(stdout="Segmentation fault"), "no JSON envelope"),
        "ok:false": (dict(stdout=json.dumps({"ok": False, "error": "inference.local unreachable"})), "ok:false"),
        "empty final": (dict(stdout=json.dumps({"ok": True, "final": "  "})), "empty reply"),
    }
    for label, (kwargs, needle) in broken.items():
        arrange(**kwargs)
        try:
            build_patch(violation, repo_root=REPO_ROOT)
            check(f"{label} -> PatchGenerationError", False, "patch was accepted")
        except PatchGenerationError as exc:
            check(f"{label} -> PatchGenerationError", needle in str(exc), str(exc))

    # 7. missing binary
    patch_nemoclaw.NEMOCLAW_BIN = str(work / "does-not-exist")
    try:
        build_patch(violation, repo_root=REPO_ROOT)
        check("missing nemoclaw binary -> PatchGenerationError", False, "patch was accepted")
    except PatchGenerationError as exc:
        check("missing nemoclaw binary -> PatchGenerationError", "not found" in str(exc), str(exc))

    # 8. unknown backend
    patch_llm.BACKEND = "bogus"
    try:
        patch_llm.call_model("x")
        check("unknown backend -> PatchGenerationError", False, "call returned")
    except PatchGenerationError as exc:
        check("unknown backend -> PatchGenerationError", "unknown GUARDRAIL_PATCH_BACKEND" in str(exc), str(exc))

    # optional: one real turn through the sandbox
    if "--real" in sys.argv:
        patch_llm.BACKEND = "nemoclaw"
        patch_nemoclaw.NEMOCLAW_BIN = os.environ.get("GUARDRAIL_NEMOCLAW_BIN", "nemoclaw")
        try:
            result = build_patch(violation, repo_root=REPO_ROOT)
            check(f"real sandbox -> valid patch ({result['latency_s']}s)", result["valid"])
            print(result["patch_diff"])
        except PatchGenerationError as exc:
            check("real sandbox -> valid patch", False, str(exc))

    print(f"\n{'RESULT: PASS' if not failures else f'RESULT: FAIL ({failures} case(s))'}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
