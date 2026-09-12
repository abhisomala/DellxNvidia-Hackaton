#!/usr/bin/env python3
"""GuardRail pipeline: scan -> insert -> vision -> patch -> apply -> six gates -> record -> report.

Stages
------
1. **scan**    two real Path 1 scans of the same page: axe-core
               (``scripts/a11y-scan.js``) and the keyboard probe
               (``scripts/keyboard-scan.js``, real Tab / Shift+Tab / Escape key
               presses in Chromium, for what axe cannot see).  The probe's
               report is axe-shaped, so both are merged into one report.
2. **insert**  that merged report as one ``scans`` document via ``db.mongo_store``
2b. **vision** ``pipeline.vision_audit``: gemma4:26b judges screenshots of the page
               for visual-only WCAG failures (contrast over imagery, invisible focus,
               clipping, colour-only meaning, target size, 320px reflow) and reviews
               its visual design.  Findings are appended to the scan with
               ``source: "vision"`` and a confidence; nothing axe or the probe
               already flagged is repeated.  Vision findings are recorded for review,
               not auto-patched.  Disable with ``--no-vision`` / ``GUARDRAIL_VISION=0``.
3. **patch**   a patch from the local Ollama model (gemma4:26b) via
               ``pipeline.patch_llm``; ``locate.mjs`` picks the file (the script,
               not the page, for keyboard rules).  Prompt and raw model response
               are saved in the run directory.
4. **apply**   by default to a copy of the app under the run directory; with
               ``--in-place`` to the REAL file, backed up first and restored
               unless every gate passes.
5. **gates**   all six run every time, each recorded as
               passed | failed | unavailable | not-applicable:

               - ``diff-size``  Path 2's ``guardDiff`` via ``pipeline/gates_cli.mjs``
                 (at most 80 added / 40 removed lines, 2 files)
               - ``build``      not applicable: this static HTML/JS site has no
                 build step.  The patched file's syntax check
                 (``patch_validate``) is the only compile-like check, and a
                 syntax failure fails the gate.
               - ``rescan``     axe + keyboard probe over the patched page: the
                 target violation is gone and nothing new appeared
               - ``functional`` ``integrity-check/check.js`` over the patched page
                 (``--require-dialog-keyboard`` for keyboard rules)
               - ``reviewer``   Path 2's model reviewer via ``gates_cli.mjs judge``;
                 mandatory, so an unreachable reviewer is ``unavailable``, never
                 a pass
               - ``visual``     the patched page is captured again and compared with
                 the baseline capture: pixel-identical regions and focus stops pass
                 with no model call; changed ones are re-checked by the vision model
                 (thinking off).  ``not-applicable`` only when vision was disabled.

               ``verified`` only when diff-size, rescan, functional, reviewer and
               visual passed and the syntax check behind build passed.
6. **record**  a verified patch through Path 2's own bridge, with the audit
               event's gate list corrected to what really ran
7. **report**  regenerates the audit report from a real query

Nothing fails open: a gate that did not run is ``unavailable``, which is not a
pass; every subprocess and network call is bounded by a timeout.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlparse

REPO_ROOT = Path(__file__).resolve().parents[1]
# The dashboard and the watcher import this as ROOT; keep both names.
ROOT = REPO_ROOT
sys.path.insert(0, str(REPO_ROOT))

from db.mongo_store import MongoStore  # noqa: E402
from pipeline.patch_llm import PatchGenerationError, build_patch  # noqa: E402
from pipeline.patch_validate import validate  # noqa: E402
from pipeline import vision_audit  # noqa: E402
from db.axe_adapter import source_file_from_url  # noqa: E402

SCANNER = REPO_ROOT / "scripts" / "a11y-scan.js"
SCANNER_OUTPUT = REPO_ROOT / "reports" / "a11y-report.json"
KEYBOARD_SCANNER = REPO_ROOT / "scripts" / "keyboard-scan.js"
GATES_CLI = REPO_ROOT / "pipeline" / "gates_cli.mjs"
DEMO_DIR = REPO_ROOT / "demo"
RUNS_DIR = REPO_ROOT / "pipeline" / "runs"
# Path 2's own bridge, now that remediation/ is in this tree. It was
# previously vendored under pipeline/path2_bridge/ from 81e6cb7 and had
# gone two commits stale. Same depth (parents[2] resolves the repo root
# either way), and it reads the same report.mongo_patch.scan_id and
# status this pipeline writes.
BRIDGE = REPO_ROOT / "remediation" / "bridge" / "record_to_mongo.py"
REPORT_GENERATOR = REPO_ROOT / "audit-report" / "generate_report.py"
INTEGRITY_CHECK = REPO_ROOT / "integrity-check" / "check.js"

SCAN_TIMEOUT_S = 120
GUARD_TIMEOUT_S = 60
FUNCTIONAL_TIMEOUT_S = 180
REVIEWER_TIMEOUT_S = 240
BRIDGE_TIMEOUT_S = 60
REPORT_TIMEOUT_S = 120

GATE_NAMES = ("diff-size", "build", "rescan", "functional", "reviewer", "visual")
GUARD_LIMITS = {"max_added_lines": 80, "max_removed_lines": 40, "max_files": 2}


def vision_enabled_by_default() -> bool:
    return os.environ.get("GUARDRAIL_VISION", "1") != "0"


class StageError(RuntimeError):
    """A pipeline stage did not produce what the next stage needs."""


def log(stage: str, message: str) -> None:
    print(f"[{stage}] {message}", flush=True)


def tail(text: str | None, limit: int = 800) -> str:
    return (text or "").strip()[-limit:] or "(none)"


def rel(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def run_command(
    args: list[str], *, timeout: int, label: str, stdin: str | None = None, env: dict | None = None
) -> subprocess.CompletedProcess:
    """subprocess.run with a hard timeout; a hang or a missing binary is a StageError."""
    try:
        return subprocess.run(
            args, cwd=REPO_ROOT, capture_output=True, text=True, input=stdin, timeout=timeout, env=env,
        )
    except subprocess.TimeoutExpired as exc:
        raise StageError(f"{label}: did not finish within {timeout}s") from exc
    except OSError as exc:
        raise StageError(f"{label}: could not start {args[0]}: {exc}") from exc


def parse_json_output(stdout: str | None) -> dict | None:
    """The JSON object a CLI printed (the last non-empty line), or None."""
    lines = [line for line in (stdout or "").splitlines() if line.strip()]
    for candidate in ((stdout or "").strip(), lines[-1] if lines else ""):
        try:
            value = json.loads(candidate)
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(value, dict):
            return value
    return None


def record_stage(
    store: MongoStore,
    *,
    run_id: str,
    target: str,
    trigger_source: str,
    stage: str,
    **extra: object,
) -> None:
    """Log where the run got to, and whether a human or the watcher started it.

    ``scan_run`` is the event type MongoStore accepts for pipeline progress;
    the stage name is documented extra data rather than a new event type.
    """
    store.insert_audit_event("scan_run", {
        "run_id": run_id,
        "target_app": target,
        "trigger_source": trigger_source,
        "stage": stage,
        **extra,
    })


def violation_key(entry: dict) -> tuple:
    return (entry.get("rule_id"), entry.get("selector"))


def axe_keys(report: dict) -> set[tuple]:
    """The (rule, selector) pairs an axe-shaped report reports, flattened over nodes."""
    pairs = set()
    for violation in report.get("violations") or []:
        for node in violation.get("nodes") or [{}]:
            pairs.add((violation.get("id"), " ".join(node.get("target") or [])))
    return pairs


def show_keys(keys) -> str:
    return ", ".join(f"{rule}@{selector}" for rule, selector in sorted(keys)) or "none"


def expected_file_url(target: Path) -> str:
    """The URL Path 1 builds for a local target (``'file://' + path.resolve(...)``)."""
    return "file://" + str(target.resolve())


def same_target(reported_url: str, target: Path) -> bool:
    """Whether the report really describes the file we asked to scan."""
    parsed = urlparse(reported_url)
    if parsed.scheme not in ("", "file"):
        return False
    try:
        return Path(unquote(parsed.path)).resolve() == target.resolve()
    except OSError:
        return False


def run_scanner(target: Path, label: str) -> tuple[dict, int]:
    """Run Path 1's axe scan unmodified; return (report, exit code), or raise.

    Path 1 exits 1 both when it found violations and when node fails to load
    it at all (a missing module never reaches its own error handler), so the
    exit code alone cannot be trusted.  Instead the report artifact is
    validated: the stale file is removed first, then the fresh one must exist,
    parse, carry a ``violations`` array, and describe the target we actually
    asked for.  That last check is what catches a crashed rescan quietly
    leaving the previous scan's report in place.

    The scanner always writes ``reports/a11y-report.json`` next to itself, so
    the baseline copy is preserved and restored around a verification rescan.
    """
    preserved = SCANNER_OUTPUT.read_text() if SCANNER_OUTPUT.exists() else None
    SCANNER_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    SCANNER_OUTPUT.unlink(missing_ok=True)

    try:
        process = run_command(
            ["node", str(SCANNER), str(target)], timeout=SCAN_TIMEOUT_S, label=f"{label}: axe scanner",
        )
        stderr = (process.stderr or "").strip()

        # 0 = clean, 1 = violations found, 2 = the scanner's own error handler.
        if process.returncode not in (0, 1):
            raise StageError(
                f"{label}: scanner exited {process.returncode}: {stderr[-800:] or '(no stderr)'}"
            )
        # A node-level crash also exits 1 without producing a report.
        if not SCANNER_OUTPUT.exists():
            raise StageError(
                f"{label}: scanner exited {process.returncode} but wrote no report - "
                f"it did not run. stderr: {stderr[-800:] or '(no stderr)'}"
            )
        for signature in ("Cannot find module", "MODULE_NOT_FOUND", "SyntaxError"):
            if signature in stderr:
                raise StageError(f"{label}: scanner crashed ({signature}): {stderr[-800:]}")

        try:
            report = json.loads(SCANNER_OUTPUT.read_text())
        except json.JSONDecodeError as exc:
            raise StageError(f"{label}: scanner report is not valid JSON: {exc}") from exc

        if not isinstance(report.get("violations"), list):
            raise StageError(f"{label}: scanner report has no violations array")
        reported_url = report.get("url")
        if not same_target(reported_url or "", target):
            raise StageError(
                f"{label}: report describes {reported_url!r} but {expected_file_url(target)!r} "
                "was requested - refusing to treat a stale or wrong report as this scan"
            )
    finally:
        if preserved is not None and label != "baseline":
            SCANNER_OUTPUT.write_text(preserved)
    return report, process.returncode


def run_keyboard_scanner(target: Path, run_dir: Path, label: str) -> tuple[dict, int]:
    """Run the keyboard probe; return (report, exit code), or raise.

    Its stdout is the key-press trace, the reproduction evidence, so it goes
    into the log before anything is judged.  The report must be fresh, parse,
    describe the requested page, and agree with the exit code (1 exactly when
    it reports violations) - a probe that did not really run never reads as
    "no keyboard problems".
    """
    out = run_dir / f"keyboard-{label}.json"
    out.unlink(missing_ok=True)
    if not KEYBOARD_SCANNER.exists():
        raise StageError(f"{label}: keyboard probe missing at {KEYBOARD_SCANNER}")
    process = run_command(
        ["node", str(KEYBOARD_SCANNER), str(target), "--out", str(out)],
        timeout=SCAN_TIMEOUT_S, label=f"{label}: keyboard probe",
    )
    for line in (process.stdout or "").splitlines():
        if line.strip():
            log(f"{label}:keyboard", line.rstrip())

    if process.returncode not in (0, 1):
        raise StageError(
            f"{label}: keyboard probe exited {process.returncode} (harness error, the probe did not run): "
            f"{tail(process.stderr)}"
        )
    if not out.exists():
        raise StageError(f"{label}: keyboard probe exited {process.returncode} but wrote no report to {rel(out)}")
    try:
        report = json.loads(out.read_text())
    except json.JSONDecodeError as exc:
        raise StageError(f"{label}: keyboard probe report is not valid JSON: {exc}") from exc
    if not isinstance(report, dict) or not isinstance(report.get("violations"), list):
        raise StageError(f"{label}: keyboard probe report has no violations array")
    if not isinstance(report.get("probes"), list):
        raise StageError(f"{label}: keyboard probe report has no probes trace")
    reported_url = report.get("url")
    if not same_target(reported_url or "", target):
        raise StageError(
            f"{label}: keyboard probe describes {reported_url!r} but {expected_file_url(target)!r} "
            "was requested - refusing to treat a stale or wrong report as this scan"
        )
    if (process.returncode == 1) != bool(report["violations"]):
        raise StageError(
            f"{label}: keyboard probe exit {process.returncode} disagrees with its report "
            f"({len(report['violations'])} violation type(s)) - not trusting either"
        )
    return report, process.returncode


def scan_target(target: Path, run_dir: Path, label: str) -> dict:
    """axe + keyboard probe over one page, merged into one axe-shaped report."""
    axe, axe_exit = run_scanner(target, label)
    keyboard, keyboard_exit = run_keyboard_scanner(target, run_dir, label)
    merged = dict(axe)
    merged["violations"] = list(axe["violations"]) + list(keyboard["violations"])
    merged["guardrail_keyboard_probe"] = {
        "testEngine": keyboard.get("testEngine"),
        "report": f"keyboard-{label}.json",
        "violations": [v.get("id") for v in keyboard["violations"]],
    }
    saved = run_dir / f"axe-{label}.json"
    saved.write_text(json.dumps(merged, indent=2))
    log(
        label,
        f"scanned {target} (urls verified): axe exit {axe_exit} -> {len(axe_keys(axe))} failing element(s); "
        f"keyboard probe exit {keyboard_exit} -> {len(axe_keys(keyboard))}; merged into {saved.name}",
    )
    return merged


# --- gates -------------------------------------------------------------------


def gate_diff_size(diff: str, changed_files: list[str]) -> dict:
    """Path 2's guardDiff over the unified diff."""
    request = {"diff": diff, "changed_files": changed_files, **GUARD_LIMITS}
    try:
        process = run_command(
            ["node", str(GATES_CLI), "guard"], stdin=json.dumps(request),
            timeout=GUARD_TIMEOUT_S, label="diff-size gate",
        )
    except StageError as exc:
        return {"status": "unavailable", "error": str(exc)}
    result = parse_json_output(process.stdout)
    if process.returncode != 0 or result is None:
        why = (result or {}).get("error") or tail(process.stderr)
        return {"status": "unavailable", "error": f"gates_cli guard exited {process.returncode}: {why}"}
    ok = result.get("ok") is True and not result.get("reasons")
    return {
        "status": "passed" if ok else "failed",
        "added": result.get("added"),
        "removed": result.get("removed"),
        "files": result.get("files"),
        "reasons": result.get("reasons") or [],
        "limits": GUARD_LIMITS,
    }


def gate_build(patched_file: Path) -> dict:
    """No build step exists for static HTML/JS; the syntax check is all there is."""
    try:
        syntax_ok, syntax_error = validate(patched_file.name, patched_file.read_text())
    except Exception as exc:  # noqa: BLE001 - a check that did not run is not a pass
        return {"status": "unavailable", "build_step": None, "syntax_ok": False,
                "syntax_error": f"syntax check did not run: {exc}"}
    return {
        "status": "not-applicable" if syntax_ok else "failed",
        "build_step": None,
        "syntax_ok": bool(syntax_ok),
        "syntax_error": syntax_error or None,
    }


def gate_rescan(baseline: dict, verify_page: Path, run_dir: Path, target_key: tuple) -> tuple[dict, dict | None]:
    """axe + keyboard probe over the patched page; returns (gate record, merged report or None)."""
    try:
        after = scan_target(verify_page, run_dir, "verify")
    except StageError as exc:
        return {"status": "unavailable", "error": str(exc)}, None
    before_keys, after_keys = axe_keys(baseline), axe_keys(after)
    target_gone = target_key not in after_keys
    regressions = sorted(after_keys - before_keys)
    return {
        "status": "passed" if target_gone and not regressions else "failed",
        "target": list(target_key),
        "target_gone": target_gone,
        "new_violations": [list(k) for k in regressions],
        "baseline": [list(k) for k in sorted(before_keys)],
        "after": [list(k) for k in sorted(after_keys)],
    }, after


def gate_functional(verify_page: Path, run_dir: Path, rule_id: str) -> dict:
    """integrity-check/check.js over the patched page."""
    args = ["node", str(INTEGRITY_CHECK), str(verify_page)]
    if rule_id.startswith("keyboard-"):
        args.append("--require-dialog-keyboard")
    output_file = run_dir / "integrity-check.txt"
    try:
        process = run_command(args, timeout=FUNCTIONAL_TIMEOUT_S, label="functional gate")
    except StageError as exc:
        output_file.write_text(str(exc) + "\n")
        return {"status": "unavailable", "error": str(exc), "args": args[2:]}
    output = (process.stdout or "") + (process.stderr or "")
    output_file.write_text(output)
    summary = [line.strip() for line in output.splitlines() if "checks passed" in line]
    record = {"exit_code": process.returncode, "summary": " | ".join(summary) or None, "args": args[2:]}
    if process.returncode == 0:
        return {"status": "passed", **record}
    if process.returncode == 1:
        return {"status": "failed", **record}
    return {"status": "unavailable", "harness_error": True,
            "error": f"integrity check harness broke (exit {process.returncode}): {tail(output)}", **record}


def gate_reviewer(violation: dict, diff: str, run_dir: Path) -> dict:
    """Path 2's model reviewer; mandatory, so anything short of a real approval fails."""
    judge_url = os.environ.get("GUARDRAIL_JUDGE_URL", "http://127.0.0.1:11434/v1")
    judge_model = os.environ.get("GUARDRAIL_JUDGE_MODEL", "gemma4:26b")
    request = {
        "violation": {
            "rule_id": violation.get("rule_id") or "",
            "description": violation.get("description") or "",
            "selector": violation.get("selector") or "",
            "html": violation.get("html") or "",
        },
        "diff": diff,
        "judge_url": judge_url,
        "judge_model": judge_model,
        "reasoning_effort": "none",
    }
    if os.environ.get("GUARDRAIL_JUDGE_KEY"):
        request["judge_key"] = os.environ["GUARDRAIL_JUDGE_KEY"]
    exit_code = None
    try:
        process = run_command(
            ["node", str(GATES_CLI), "judge"], stdin=json.dumps(request),
            timeout=REVIEWER_TIMEOUT_S, label="reviewer gate",
        )
        exit_code = process.returncode
        result = parse_json_output(process.stdout) or {
            "ok": False, "status": "unavailable",
            "error": f"gates_cli judge exited {exit_code} without a JSON result: {tail(process.stderr)}",
        }
    except StageError as exc:
        result = {"ok": False, "status": "unavailable", "error": str(exc)}
    (run_dir / "reviewer.json").write_text(json.dumps(result, indent=2))

    if exit_code == 0 and result.get("ok") is True and result.get("status") == "passed":
        status = "passed"
    elif exit_code == 0 and result.get("status") == "failed":
        status = "failed"
    else:
        status = "unavailable"
    return {
        "status": status,
        "reviewer_status": result.get("status"),
        "exit_code": exit_code,
        "ms": result.get("ms"),
        "reasons": result.get("reasons") or [],
        "error": result.get("error"),
        "judge_url": judge_url,
        "judge_model": judge_model,
    }


def gate_visual(verify_page: Path, run_dir: Path, vision_ran: bool) -> dict:
    """Capture the patched page and compare it with the baseline capture."""
    if not vision_ran:
        return {"status": "not-applicable", "disabled_by_operator": True,
                "reason": "vision was disabled for this run (--no-vision / GUARDRAIL_VISION=0)"}
    baseline_dir, verify_dir = run_dir / "vision", run_dir / "vision-verify"
    if not (baseline_dir / "capture.json").exists():
        return {"status": "unavailable", "error": "the baseline vision capture did not run, so there is nothing to compare"}
    try:
        vision_audit.run_capture(verify_page, verify_dir)
        return vision_audit.regression_check(baseline_dir, verify_dir, verify_dir)
    except vision_audit.VisionCaptureError as exc:
        return {"status": "unavailable", "error": f"patched page capture failed: {exc}"}
    except Exception as exc:  # noqa: BLE001 - a gate that did not run is not a pass
        return {"status": "unavailable", "error": f"visual gate crashed: {type(exc).__name__}: {exc}"}


def run_vision_stage(target: Path, run_dir: Path) -> dict:
    """The vision audit; never raises.  Returns the report, or an unavailable stub."""
    try:
        return vision_audit.audit_page(
            target, run_dir / "vision", known_report=run_dir / "axe-baseline.json",
            source_file=source_file_from_url(expected_file_url(target)),
        )
    except vision_audit.VisionCaptureError as exc:
        error = f"vision capture failed: {exc}"
    except Exception as exc:  # noqa: BLE001 - reported as unavailable, never as "no visual issues"
        error = f"vision stage crashed: {type(exc).__name__}: {exc}"
    return {"status": "unavailable", "error": error, "violations": [], "findings": [],
            "artifacts_dir": rel(run_dir / "vision")}


def gate_satisfied(name: str, record: dict) -> bool:
    if name == "build":
        return record["status"] == "passed" or (
            record["status"] == "not-applicable" and record.get("syntax_ok") is True
        )
    if name == "visual":
        return record["status"] == "passed" or (
            record["status"] == "not-applicable" and record.get("disabled_by_operator") is True
        )
    return record["status"] == "passed"


def gate_detail(name: str, record: dict) -> str:
    if record.get("error"):
        return record["error"][:160]
    if name == "diff-size":
        return f"added={record['added']} removed={record['removed']} files={record['files']}"
    if name == "build":
        return "no build step (static HTML/JS); syntax " + ("ok" if record.get("syntax_ok") else f"FAILED: {record.get('syntax_error')}")
    if name == "rescan":
        return f"target gone={record['target_gone']}; new={record['new_violations'] or 'none'}"
    if name == "functional":
        return record.get("summary") or f"exit {record.get('exit_code')}"
    if name == "reviewer":
        return f"{record.get('reviewer_status')} in {record.get('ms')}ms; reasons={record.get('reasons') or 'none'}"
    if name == "visual":
        if record["status"] == "not-applicable":
            return record.get("reason", "")
        return (f"{record.get('changed')}/{record.get('compared')} changed; model re-check "
                f"{'ran' if record.get('model_called') else 'not needed'}; {record.get('reason', '')}")[:160]
    return ""


# --- pipeline ----------------------------------------------------------------


def run_pipeline(
    target: str | None = None,
    trigger_source: str = "manual",
    *,
    skip_report: bool = False,
    rule: str | None = None,
    in_place: bool = False,
    vision: bool | None = None,
) -> dict:
    """Run the pipeline once, one run at a time.

    The watcher, the dashboard and a manual run all write the same scanner
    report file and may edit the same demo files, so an overlapping run waits
    for the current one to finish instead of colliding with it.
    """
    import fcntl

    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    with open(RUNS_DIR / ".pipeline.lock", "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log("setup", "another pipeline run is in progress; waiting for it to finish")
            fcntl.flock(lock, fcntl.LOCK_EX)
        return _run_pipeline_once(
            target, trigger_source, skip_report=skip_report, rule=rule, in_place=in_place, vision=vision
        )


def _run_pipeline_once(
    target: str | None = None,
    trigger_source: str = "manual",
    *,
    skip_report: bool = False,
    rule: str | None = None,
    in_place: bool = False,
    vision: bool | None = None,
) -> dict:
    """Run scan -> insert -> vision -> patch -> apply -> gates -> record -> report once.

    Returns the run summary.  Raises on any stage that did not produce what
    the next one needs, and when any gate did not pass, so a caller (the
    dashboard, the watcher) reports a failed run instead of an empty one.
    """
    target = target or str(DEMO_DIR / "index.html")
    target_path = Path(target)
    vision = vision_enabled_by_default() if vision is None else vision

    started = datetime.now(timezone.utc)
    run_dir = RUNS_DIR / started.strftime("%Y%m%d-%H%M%S")
    run_dir.mkdir(parents=True, exist_ok=True)
    run_id = run_dir.name
    log("setup", f"run directory {rel(run_dir)} (trigger_source={trigger_source}, in_place={in_place}, vision={vision})")

    environment = {**os.environ, "MONGODB_URI": os.environ.get("MONGODB_URI", "mongodb://localhost:27017")}
    store = MongoStore(server_selection_timeout_ms=3000)
    try:
        store.ping()
        store.ensure_indexes()
        log("setup", f"connected to {store.database.name} on {store.client.address}")

        # --- 1. scan (axe + keyboard probe) ----------------------------------
        baseline = scan_target(target_path, run_dir, "baseline")

        # --- 2. insert -----------------------------------------------------
        vision_state = {"status": "running", "started_at": datetime.now(timezone.utc).isoformat()} if vision else {
            "status": "disabled", "reason": "--no-vision / GUARDRAIL_VISION=0"}
        scan_id = store.insert_axe_scan(baseline, extra_fields={"vision_audit": vision_state})
        scan = store.get_scan(scan_id)
        log("insert", f"scans._id={scan_id} target_app={scan['target_app']} violations={len(scan['violations'])}")
        record_stage(
            store, run_id=run_id, target=scan["target_app"], trigger_source=trigger_source,
            stage="scan", scan_id=str(scan_id), violations=len(scan["violations"]),
        )

        # --- 2b. vision ------------------------------------------------------
        vision_report: dict = {"status": "disabled"}
        if vision:
            record_stage(store, run_id=run_id, target=scan["target_app"], trigger_source=trigger_source,
                         stage="vision", scan_id=str(scan_id))
            try:
                vision_report = run_vision_stage(target_path, run_dir)
            finally:
                if vision_report.get("status") == "disabled":  # interrupted before any result existed
                    store.attach_vision_audit(scan_id, [], {**vision_state, "status": "unavailable",
                                                            "error": "the run stopped during the vision audit"})
            summary_doc = (vision_audit.scan_summary(vision_report) if "tasks" in vision_report
                           else {k: vision_report.get(k) for k in ("status", "error", "artifacts_dir")})
            store.attach_vision_audit(scan_id, vision_report.get("violations") or [], summary_doc)
            scan = store.get_scan(scan_id)
            findings = vision_report.get("findings") or []
            cache = vision_report.get("cache") or {}
            if vision_report["status"] == "unavailable":
                log("vision", f"!!! VISION AUDIT UNAVAILABLE - visual checks did NOT run: {vision_report.get('error')}")
            else:
                log("vision", f"status={vision_report['status']} findings={len(findings)} "
                              f"latency={vision_report.get('latency_s')}s cache={cache.get('hits')}/{cache.get('calls')} "
                              f"deduplicated={len(vision_report.get('deduplicated') or [])} "
                              f"-> appended to scans._id={scan_id} with source=vision")
                for finding in findings:
                    log("vision", f"  vision-{finding['category']} {finding['selector']} "
                                  f"confidence={finding['confidence']} ({finding['method']}): {finding['title']}")
            record_stage(store, run_id=run_id, target=scan["target_app"], trigger_source=trigger_source,
                         stage="vision", scan_id=str(scan_id), vision_status=vision_report["status"],
                         vision_findings=len(findings), complete=True)
            try:
                released = vision_audit.judge.release()
                if released:
                    log("vision", f"released {', '.join(released)} so the gemma4:26b patch and reviewer calls load "
                                  "without waiting behind it")
            except vision_audit.judge.VisionModelError as exc:
                log("vision", f"could not release the vision runner (patching may wait for it): {exc}")

        dom_violations = [v for v in scan["violations"] if v.get("source") != "vision"]
        if not dom_violations:
            raise StageError(
                "the DOM scan found no violations, so there is nothing to patch"
                + (f" ({len(scan['violations'])} vision finding(s) are recorded for review)" if scan["violations"] else "")
            )

        # --- 3. select + patch ----------------------------------------------
        target_violation = dom_violations[0]
        if rule:
            if rule.startswith("vision-"):
                raise StageError(f"{rule!r} is a vision finding: those are recorded for review, not auto-patched")
            matches = [v for v in dom_violations if v.get("rule_id") == rule]
            if not matches:
                found = sorted({str(v.get("rule_id")) for v in dom_violations})
                raise StageError(f"the scan reported no {rule!r} violation to patch; rule_ids found: {found}")
            target_violation = matches[0]
        log("select", f"target {target_violation['rule_id']} @ {target_violation['selector']}")

        try:
            patch = build_patch(target_violation, repo_root=REPO_ROOT)
        except PatchGenerationError as exc:
            for name, key in (("prompt.txt", "prompt"), ("model-response.txt", "raw_response")):
                if exc.result.get(key):
                    (run_dir / name).write_text(exc.result[key])
            raise StageError(f"patch generation failed: {exc}") from exc
        (run_dir / "patch.diff").write_text(patch["patch_diff"])
        (run_dir / "prompt.txt").write_text(patch["prompt"])
        (run_dir / "model-response.txt").write_text(patch["raw_response"])
        log(
            "patch",
            f"{patch['rule_id']} @ {patch['selector']} in {patch['source_file']}:{patch['line']} "
            f"(located by {patch['location_method']}; model_used={patch['model_used']}, latency_s={patch['latency_s']})",
        )

        # --- 4. apply ------------------------------------------------------
        real_file = (REPO_ROOT / patch["source_file"]).resolve()
        app_dir = target_path.resolve().parent
        if app_dir not in real_file.parents:
            raise StageError(f"the patch targets {patch['source_file']}, outside the scanned app {rel(app_dir)}")
        if real_file.read_text() != patch["original_text"]:
            raise StageError(f"{patch['source_file']} changed on disk after the patch was generated")

        backup = None
        if in_place:
            backup = run_dir / f"original-{real_file.name}"
            backup.write_text(patch["original_text"])
            patched_file, verify_page = real_file, target_path.resolve()
        else:
            runs = RUNS_DIR.resolve()
            if app_dir == runs or app_dir in runs.parents:
                raise StageError(f"refusing to copy {rel(app_dir)}: it contains the run directory")
            verify_root = run_dir / "verify"
            if verify_root.exists():
                shutil.rmtree(verify_root)
            verify_app = verify_root / app_dir.name
            shutil.copytree(app_dir, verify_app, ignore=shutil.ignore_patterns("node_modules", ".git"))
            patched_file = verify_app / real_file.relative_to(app_dir)
            verify_page = verify_app / target_path.name
            patched_file.write_text(patch["patched_text"])
            log("apply", f"copy mode: patched {rel(patched_file)}; re-verifying page {rel(verify_page)} "
                         f"(real files untouched)")

        kept = not in_place
        restored = False

        def restore_original(reason: str) -> None:
            nonlocal restored
            restored = True
            real_file.write_text(patch["original_text"])
            if real_file.read_text() == patch["original_text"]:
                log("apply", f"!!! {reason}: RESTORED the original {rel(real_file)} from {rel(backup)} "
                             "- the real file is back to its pre-run text")
            else:
                log("apply", f"!!! {reason}: RESTORE OF {rel(real_file)} FAILED - copy {rel(backup)} back by hand")

        try:
            if in_place:
                real_file.write_text(patch["patched_text"])
                log("apply", f"IN-PLACE: wrote the patch to the REAL file {rel(real_file)}; "
                             f"original backed up to {rel(backup)}; it is restored unless every gate passes")

            # --- 5. gates: all six, every time ---------------------------------
            gates: dict[str, dict] = {}
            diff = patch["patch_diff"]

            gates["diff-size"] = gate_diff_size(diff, [patch["source_file"]])
            g = gates["diff-size"]
            limits = "/".join(str(GUARD_LIMITS[k]) for k in ("max_added_lines", "max_removed_lines", "max_files"))
            log("gate:diff-size", f"added={g.get('added')} removed={g.get('removed')} files={g.get('files')} "
                                  f"limits={limits} -> {g['status']}"
                                  + (f"; {g.get('error') or g.get('reasons')}" if g["status"] != "passed" else ""))

            gates["build"] = gate_build(patched_file)
            g = gates["build"]
            log("gate:build", "no build step exists for this static HTML/JS site -> not-applicable; "
                              f"syntax check of {rel(patched_file)}: "
                              + ("ok" if g["syntax_ok"] else f"FAILED ({g['syntax_error']})")
                              + f" -> {g['status']}")

            target_key = violation_key(target_violation)
            gates["rescan"], after = gate_rescan(baseline, verify_page, run_dir, target_key)
            g = gates["rescan"]
            if after is not None:
                log("gate:rescan", f"baseline: {show_keys(axe_keys(baseline))}")
                log("gate:rescan", f"after:    {show_keys(axe_keys(after))}")
                log("gate:rescan", f"target {target_key} gone={g['target_gone']}; "
                                   f"new={show_keys(tuple(k) for k in g['new_violations'])} -> {g['status']}")
            else:
                log("gate:rescan", f"did not run: {g['error']} -> {g['status']}")

            gates["functional"] = gate_functional(verify_page, run_dir, target_violation["rule_id"])
            g = gates["functional"]
            log("gate:functional", f"check.js {' '.join(g.get('args') or [])}: "
                                   f"{g.get('summary') or g.get('error') or 'no summary'} -> {g['status']}")

            gates["reviewer"] = gate_reviewer(target_violation, diff, run_dir)
            g = gates["reviewer"]
            log("gate:reviewer", f"{g['judge_model']} at {g['judge_url']}: status={g['reviewer_status']} "
                                 f"ms={g['ms']} reasons={g['reasons'] or 'none'}"
                                 + (f" error={g['error']}" if g.get("error") else "") + f" -> {g['status']}")

            gates["visual"] = gate_visual(verify_page, run_dir, vision)
            g = gates["visual"]
            if g["status"] == "not-applicable":
                log("gate:visual", f"{g['reason']} -> not-applicable")
            elif g.get("compared") is None:
                log("gate:visual", f"did not run: {g.get('error')} -> {g['status']}")
            else:
                log("gate:visual", f"compared {g['compared']} regions/focus stops with the baseline capture: "
                                   f"{g['changed']} changed, measured regressions={g['measured_regressions'] or 'none'}, "
                                   f"model re-check {'ran (thinking off)' if g['model_called'] else 'not needed'}"
                                   + (f", error={g['error']}" if g.get("error") else "") + f" -> {g['status']}")

            statuses = {name: gates[name]["status"] for name in GATE_NAMES}
            failed_gates = [name for name in GATE_NAMES if not gate_satisfied(name, gates[name])]
            verified = not failed_gates
            (run_dir / "gates.json").write_text(json.dumps(gates, indent=2))

            log("gates", f"{'gate':<11} {'status':<15} detail")
            for name in GATE_NAMES:
                log("gates", f"{name:<11} {statuses[name]:<15} {gate_detail(name, gates[name])}")
            log("gates", f"VERIFIED={verified} (all six gates ran; decided by their results, not asserted)")

            verification_scan_id = None
            if after is not None:
                verification_scan_id = store.insert_axe_scan(after)
                log("verify", f"verification scan stored as scans._id={verification_scan_id}")

            # --- 6. record ------------------------------------------------------
            rescan = gates["rescan"]
            report_doc = {
                "violation_id": f"{patch['rule_id']}#0",
                "rule_id": patch["rule_id"],
                "selector": patch["selector"],
                "status": "fixed" if verified else "failed",
                "backend": patch["model_used"],
                "started_at": started.isoformat(),
                "finished_at": datetime.now(timezone.utc).isoformat(),
                "patch": patch["patch_diff"],
                "files_changed": [patch["source_file"]],
                "location": {"file": patch["source_file"], "line": patch["line"], "method": patch["location_method"]},
                "attempts": [{"attempt": 1, "agent_ok": True, "latency_s": patch["latency_s"], "verify": {
                    "ok": verified, "target_gone": rescan.get("target_gone"),
                    "new_violations": rescan.get("new_violations"),
                    "functional_passed": statuses["functional"] == "passed",
                    "gates": statuses}}],
                "simulated": False,
                "mongo_patch": {
                    "scan_id": str(scan_id),
                    "target_app": scan["target_app"],
                    "violation_rule_id": patch["rule_id"],
                    "source_file": patch["source_file"],
                    "original_snippet": patch["original_snippet"],
                    "patched_snippet": patch["patched_snippet"],
                    "model_used": patch["model_used"],
                    "verified": verified,
                    "violation_for_scans": {
                        "rule_id": target_violation["rule_id"],
                        "selector": target_violation["selector"],
                        "severity": target_violation["severity"],
                        "description": target_violation["description"],
                        "source_file": target_violation["source_file"],
                        "html": target_violation.get("html", ""),
                    },
                },
            }
            report_path = run_dir / "report.json"
            report_path.write_text(json.dumps(report_doc, indent=2))

            summary = {
                "run_dir": rel(run_dir),
                "scan_id": str(scan_id),
                "patch_id": None,
                "verification_scan_id": str(verification_scan_id) if verification_scan_id else None,
                "verified": verified,
                "gate_results": statuses,
                "functional_check_passed": statuses["functional"] == "passed",
                "rule_id": patch["rule_id"],
                "selector": patch["selector"],
                "source_file": patch["source_file"],
                "in_place": in_place,
                "patched_file": rel(patched_file),
                "patch_is_simulated": False,
                "model_used": patch["model_used"],
                "model_latency_s": patch["latency_s"],
                "vision_status": vision_report.get("status"),
                "vision_findings": len(vision_report.get("findings") or []),
                "vision_cache": vision_report.get("cache"),
            }

            if not verified:
                # The bridge records nothing for a failed run, so it is not called.
                if in_place:
                    restore_original("NOT VERIFIED")
                (run_dir / "summary.json").write_text(json.dumps(summary, indent=2))
                record_stage(
                    store, run_id=run_id, target=scan["target_app"], trigger_source=trigger_source,
                    stage="verify", scan_id=str(scan_id), verified=False, gate_results=statuses,
                )
                raise StageError(
                    "NOT VERIFIED: gate(s) did not pass: "
                    + ", ".join(f"{name}={statuses[name]}" for name in failed_gates)
                    + ("; functional harness broke" if gates["functional"].get("harness_error") else "")
                    + (f"; original {patch['source_file']} restored" if in_place else "")
                )

            bridge = run_command(
                [sys.executable, str(BRIDGE), str(report_path)],
                timeout=BRIDGE_TIMEOUT_S, label="Path 2 bridge", env=environment,
            )
            sys.stdout.write(bridge.stdout)
            if bridge.returncode != 0:
                raise StageError(f"Path 2 bridge failed (exit {bridge.returncode}): {tail(bridge.stderr)}")
            match = re.search(r"patch ([0-9a-f]{24})", bridge.stdout)
            if not match:
                raise StageError(f"could not read the patch id from the bridge output: {bridge.stdout!r}")
            patch_id = match.group(1)
            log("record", f"bridge inserted patches._id={patch_id} (via Path 2's record_to_mongo.py)")

            if not store.mark_patch_verified(patch_id, verified=verified, verification_scan_id=verification_scan_id):
                raise StageError(f"patch {patch_id} could not be linked to its verification scan")
            log("record", f"linked verification_scan_id={verification_scan_id} onto the patch")

            # Path 2's bridge hardcodes its own five gate names onto the `verified`
            # event; replace them with what this run's gates actually reported.
            gates_passed = [name for name in GATE_NAMES if statuses[name] == "passed"]
            not_applicable = [name for name in GATE_NAMES if statuses[name] == "not-applicable"]
            corrected = store.audit_log.update_many(
                {"event_type": "verified", "details.patch_id": str(patch_id)},
                {
                    "$set": {
                        "details.gates": gates_passed,
                        "details.gate_results": statuses,
                        "details.gates_not_applicable": not_applicable,
                        "details.gates_note": (
                            "All six gates ran in GuardRail's pipeline. build has no step for this "
                            "static HTML/JS site, so it is not applicable; the patched file's syntax "
                            "check ran in its place and passed. visual compares screenshots of the "
                            "patched page with the baseline capture"
                            + ("; vision was disabled for this run, so visual is not applicable"
                               if "visual" in not_applicable else "")
                        ),
                    }
                },
            )
            if corrected.matched_count < 1:
                raise StageError(f"no verified audit event for patch {patch_id} to correct the gate record on")
            log("record", f"corrected {corrected.matched_count} verified event(s): gates={gates_passed}, "
                          f"gate_results={statuses}")

            summary["patch_id"] = str(patch_id)
            (run_dir / "summary.json").write_text(json.dumps(summary, indent=2))
            if in_place:
                kept = True
                log("apply", f"IN-PLACE: all gates passed; the REAL file {rel(real_file)} now carries the patch "
                             f"(original kept at {rel(backup)})")
        finally:
            if in_place and not kept and not restored:
                restore_original("RUN FAILED BEFORE THE PATCH WAS VERIFIED AND RECORDED")

        # --- 7. audit report from a real query -----------------------------
        if not skip_report:
            if not REPORT_GENERATOR.exists():
                raise StageError(f"missing report generator at {REPORT_GENERATOR}")
            generated = run_command(
                [sys.executable, str(REPORT_GENERATOR), "--scan-id", str(scan_id)],
                timeout=REPORT_TIMEOUT_S, label="report generation", env=environment,
            )
            sys.stdout.write(generated.stdout)
            if generated.returncode != 0:
                raise StageError(f"report generation failed (exit {generated.returncode}): {tail(generated.stderr)}")

        record_stage(
            store, run_id=run_id, target=scan["target_app"], trigger_source=trigger_source,
            stage="report", scan_id=str(scan_id), patch_id=str(patch_id), verified=verified,
        )
        return summary
    finally:
        store.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--target", default=str(DEMO_DIR / "index.html"))
    parser.add_argument("--trigger-source", default="manual", help="recorded on the run's audit events")
    parser.add_argument("--skip-report", action="store_true", help="stop after recording")
    parser.add_argument("--rule", default=None, help="patch the first violation with this rule_id")
    parser.add_argument(
        "--in-place", action="store_true",
        help="apply the patch to the REAL file (backed up; restored unless every gate passes)",
    )
    parser.add_argument(
        "--no-vision", action="store_true",
        help="skip the gemma4 vision audit (the visual gate is then not-applicable); also GUARDRAIL_VISION=0",
    )
    args = parser.parse_args()
    try:
        summary = run_pipeline(
            args.target, args.trigger_source, skip_report=args.skip_report, rule=args.rule, in_place=args.in_place,
            vision=False if args.no_vision else None,
        )
    except Exception as exc:  # noqa: BLE001 - surface the stage that broke
        print(f"\nPIPELINE FAILED: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    print()
    log("done", json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
