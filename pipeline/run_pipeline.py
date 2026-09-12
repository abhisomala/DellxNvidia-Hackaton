#!/usr/bin/env python3
"""Run the whole demo chain straight through: scan -> insert -> patch -> verify -> report.

Stages
------
1. **scan**    real Path 1 run (``scripts/a11y-scan.js``, Playwright + axe-core)
2. **insert**  the real axe output into the ``scans`` collection via ``db.mongo_store``
3. **patch**   a Path 2-shaped report.  Path 2's harness produces no output in
               this checkout, so ``pipeline.patch_stub`` generates the patch
               content deterministically and labels itself in ``model_used``.
4. **verify**  really re-runs Path 1 over a patched copy of the source and
               decides ``verified`` from that rescan; the verification scan is
               stored as its own ``scans`` document
5. **record**  patch + audit events through Path 2's own vendored bridge, then
               links the verification scan to the patch
6. **report**  regenerates the audit report from a real query

Every stage fails loudly.  Nothing is marked verified without a rescan that
actually stopped reporting the violation.  The demo app is never modified: the
patch is applied to a copy under the run directory.
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
sys.path.insert(0, str(REPO_ROOT))

from db.mongo_store import MongoStore  # noqa: E402
from pipeline.patch_stub import build_patch  # noqa: E402

SCANNER = REPO_ROOT / "scripts" / "a11y-scan.js"
SCANNER_OUTPUT = REPO_ROOT / "reports" / "a11y-report.json"
DEMO_DIR = REPO_ROOT / "demo"
RUNS_DIR = REPO_ROOT / "pipeline" / "runs"
BRIDGE = REPO_ROOT / "pipeline" / "path2_bridge" / "record_to_mongo.py"
REPORT_GENERATOR = REPO_ROOT / "audit-report" / "generate_report.py"
INTEGRITY_CHECK = REPO_ROOT / "integrity-check" / "check.js"


class StageError(RuntimeError):
    """A pipeline stage did not produce what the next stage needs."""


def log(stage: str, message: str) -> None:
    print(f"[{stage}] {message}", flush=True)


def violation_key(entry: dict) -> tuple:
    return (entry.get("rule_id"), entry.get("selector"))


def axe_keys(report: dict) -> set[tuple]:
    """The (rule, selector) pairs an axe report reports, flattened over nodes."""
    pairs = set()
    for violation in report.get("violations") or []:
        for node in violation.get("nodes") or [{}]:
            pairs.add((violation.get("id"), " ".join(node.get("target") or [])))
    return pairs


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


def run_scanner(target: Path, run_dir: Path, label: str) -> dict:
    """Run Path 1 unmodified and return its report, or raise.

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
        process = subprocess.run(
            ["node", str(SCANNER), str(target)],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
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

    saved = run_dir / f"axe-{label}.json"
    saved.write_text(json.dumps(report, indent=2))
    log(
        label,
        f"scanned {target} (exit {process.returncode}, url verified) -> "
        f"{len(axe_keys(report))} failing element(s); saved {saved.name}",
    )
    return report


def run_integrity_check(target: Path, run_dir: Path) -> tuple[bool, str]:
    """Run the Playwright behaviour check over a target; returns (passed, output).

    This is the functional gate: it catches a patch that silences a violation by
    breaking the UI.  Exit 2 means the harness itself failed, which is not a
    verdict about the patch and so fails the stage loudly.
    """
    process = subprocess.run(
        ["node", str(INTEGRITY_CHECK), str(target)],
        cwd=REPO_ROOT, capture_output=True, text=True,
    )
    output = (process.stdout or "") + (process.stderr or "")
    (run_dir / "integrity-check.txt").write_text(output)
    if process.returncode not in (0, 1):
        raise StageError(
            f"integrity check harness failed (exit {process.returncode}): {output[-800:]}"
        )
    return process.returncode == 0, output


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", default=str(DEMO_DIR / "index.html"))
    parser.add_argument("--skip-report", action="store_true", help="stop after recording")
    args = parser.parse_args()

    started = datetime.now(timezone.utc)
    run_dir = RUNS_DIR / started.strftime("%Y%m%d-%H%M%S")
    run_dir.mkdir(parents=True, exist_ok=True)
    log("setup", f"run directory {run_dir.relative_to(REPO_ROOT)}")

    store = MongoStore(server_selection_timeout_ms=3000)
    try:
        store.ping()
        store.ensure_indexes()
        log("setup", f"connected to {store.database.name} on {store.client.address}")

        # --- 1. scan -------------------------------------------------------
        baseline = run_scanner(Path(args.target), run_dir, "baseline")

        # --- 2. insert -----------------------------------------------------
        scan_id = store.insert_axe_scan(baseline)
        scan = store.get_scan(scan_id)
        log("insert", f"scans._id={scan_id} target_app={scan['target_app']} violations={len(scan['violations'])}")
        if not scan["violations"]:
            raise StageError("the scan found no violations, so there is nothing to patch")

        # --- 3. patch ------------------------------------------------------
        target_violation = scan["violations"][0]
        source_path = REPO_ROOT / target_violation["source_file"]
        if not source_path.exists():
            raise StageError(f"source file {source_path} from the scan does not exist")
        patch = build_patch(target_violation, source_path.read_text())
        (run_dir / "patch.diff").write_text(patch["patch_diff"])
        log(
            "patch",
            f"{patch['rule_id']} @ {patch['selector']} in {patch['source_file']}:{patch['line']} "
            f"(model_used={patch['model_used']})",
        )

        # --- 4. verify (real rescan over a patched copy) --------------------
        verify_root = run_dir / "verify"
        if verify_root.exists():
            shutil.rmtree(verify_root)
        shutil.copytree(DEMO_DIR, verify_root / "demo")
        patched_copy = verify_root / "demo" / source_path.name
        patched_copy.write_text(patch["patched_text"])
        log("verify", f"applied patch to copy {patched_copy.relative_to(REPO_ROOT)} (demo app untouched)")

        after = run_scanner(patched_copy, run_dir, "verify")
        before_keys, after_keys = axe_keys(baseline), axe_keys(after)
        target_key = violation_key(target_violation)
        target_gone = target_key not in after_keys
        regressions = sorted(after_keys - before_keys)
        log("verify", f"target {target_key} gone={target_gone}; new violations={regressions or 'none'}")

        # Functional gate: the rescan alone cannot tell a real fix from a patch
        # that deleted the control.
        functional_ok, functional_output = run_integrity_check(patched_copy, run_dir)
        passed_line = [l for l in functional_output.splitlines() if "checks passed" in l]
        log("verify", f"functional check passed={functional_ok} ({passed_line[-1].strip() if passed_line else 'no summary'})")

        verified = bool(target_gone and not regressions and functional_ok)
        log("verify", f"VERIFIED={verified} (decided by rescan + functional check, not asserted)")

        verification_scan_id = store.insert_axe_scan(after)
        log("verify", f"verification scan stored as scans._id={verification_scan_id}")

        # --- 5. record through Path 2's own bridge -------------------------
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
            "location": {"file": patch["source_file"], "line": patch["line"], "method": "selector-match"},
            "attempts": [{"attempt": 1, "agent_ok": True, "verify": {
                "ok": verified, "target_gone": target_gone, "new_violations": regressions,
                "functional_passed": functional_ok}}],
            "simulated": True,
            "simulated_reason": "Path 2 produced no patch output in this checkout; patch content is generated by pipeline.patch_stub",
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

        environment = {**os.environ, "MONGODB_URI": os.environ.get("MONGODB_URI", "mongodb://localhost:27017")}
        bridge = subprocess.run(
            [sys.executable, str(BRIDGE), str(report_path)],
            cwd=REPO_ROOT, capture_output=True, text=True, env=environment,
        )
        sys.stdout.write(bridge.stdout)
        if bridge.returncode != 0:
            raise StageError(f"Path 2 bridge failed (exit {bridge.returncode}): {bridge.stderr.strip()[-800:]}")
        match = re.search(r"patch ([0-9a-f]{24})", bridge.stdout)
        if not match:
            raise StageError(f"could not read the patch id from the bridge output: {bridge.stdout!r}")
        patch_id = match.group(1)
        log("record", f"bridge inserted patches._id={patch_id} (via Path 2's record_to_mongo.py)")

        if not store.mark_patch_verified(patch_id, verified=verified, verification_scan_id=verification_scan_id):
            raise StageError(f"patch {patch_id} could not be linked to its verification scan")
        log("record", f"linked verification_scan_id={verification_scan_id} onto the patch")

        # Path 2's bridge hardcodes its own five gates onto the `verified` event.
        # Only some of them really ran here, so the record is corrected instead of
        # being left claiming checks that never executed.
        gates_run = ["rescan", "functional"]
        gates_skipped = ["diff-guard", "reviewer"]
        corrected = store.audit_log.update_many(
            {"event_type": "verified", "details.patch_id": str(patch_id)},
            {
                "$set": {
                    "details.gates": gates_run,
                    "details.gates_not_run": gates_skipped,
                    "details.gates_not_applicable": ["build"],
                    "details.gates_note": (
                        "Path 2's bridge records all five gates for any fixed patch. This "
                        "pipeline really ran the rescan and functional gates; the demo app is "
                        "static HTML so there is no build to gate; the diff guard and the model "
                        "reviewer belong to Path 2's harness and did not run here"
                    ),
                }
            },
        )
        log(
            "record",
            f"corrected {corrected.modified_count} verified event(s): gates actually run={gates_run}, "
            f"not run={gates_skipped}",
        )

        summary = {
            "run_dir": str(run_dir.relative_to(REPO_ROOT)),
            "scan_id": str(scan_id),
            "patch_id": str(patch_id),
            "verification_scan_id": str(verification_scan_id),
            "verified": verified,
            "gates_run": gates_run,
            "functional_check_passed": functional_ok,
            "rule_id": patch["rule_id"],
            "selector": patch["selector"],
            "source_file": patch["source_file"],
            "patch_is_simulated": True,
        }
        (run_dir / "summary.json").write_text(json.dumps(summary, indent=2))

        # --- 6. audit report from a real query -----------------------------
        if not args.skip_report:
            if not REPORT_GENERATOR.exists():
                raise StageError(f"missing report generator at {REPORT_GENERATOR}")
            generated = subprocess.run(
                [sys.executable, str(REPORT_GENERATOR), "--scan-id", str(scan_id)],
                cwd=REPO_ROOT, capture_output=True, text=True, env=environment,
            )
            sys.stdout.write(generated.stdout)
            if generated.returncode != 0:
                raise StageError(f"report generation failed (exit {generated.returncode}): {generated.stderr.strip()[-800:]}")

        print()
        log("done", json.dumps(summary, indent=2))
        return 0
    except Exception as exc:  # noqa: BLE001 - surface the stage that broke
        print(f"\nPIPELINE FAILED: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    finally:
        store.close()


if __name__ == "__main__":
    raise SystemExit(main())
