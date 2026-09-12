#!/usr/bin/env python3
"""Local GuardRail dashboard server backed by the scanner's MongoDB collections.

Run with ``python3 dashboard_server.py``.  The API deliberately exposes only
derived read models; the browser never receives a MongoDB credential.
"""

from __future__ import annotations

import importlib.util
import json
import os
import struct
import subprocess
import sys
import threading
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urlparse

from bson import ObjectId

from db.mongo_store import MongoStore
from pipeline.run_pipeline import run_pipeline


ROOT = Path(__file__).resolve().parent
DASHBOARD_DIR = ROOT / "dashboard"
PORT = int(os.getenv("GUARDRAIL_PORT", "4173"))
ACTIVE_WINDOW_SECONDS = 15 * 60
HEARTBEAT = ROOT / "runtime" / "heartbeat.json"
LOCAL_DEMO_REPORT = ROOT / "reports" / "a11y-report.json"
# The only directory /api/artifact may read from: pipeline run outputs.
RUNS_DIR = ROOT / "pipeline" / "runs"
ARTIFACT_CACHE_CONTROL = "private, max-age=300"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
GATE_ORDER = ("diff-size", "build", "rescan", "functional", "reviewer", "visual")


def json_value(value: Any) -> Any:
    if isinstance(value, (datetime,)):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat()
    if isinstance(value, ObjectId):
        return str(value)
    raise TypeError(f"Cannot serialize {type(value).__name__}")


def identifier(value: Any) -> str:
    return str(value) if value is not None else ""


def safe_artifact(relative: Any) -> Path | None:
    """Resolve a repo-relative PNG path, or None unless it is a real file inside RUNS_DIR.

    Rejects absolute paths, any ``..`` segment, non-.png names and anything whose
    symlink-resolved location leaves ``pipeline/runs``.
    """
    if not isinstance(relative, str) or not relative or len(relative) > 1024 or "\x00" in relative:
        return None
    candidate = Path(relative)
    if candidate.is_absolute() or ".." in candidate.parts or "\\" in relative:
        return None
    if candidate.suffix.lower() != ".png":
        return None
    try:
        runs = RUNS_DIR.resolve(strict=True)
        real = (ROOT / candidate).resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        return None
    if not real.is_relative_to(runs) or real.suffix.lower() != ".png" or not real.is_file():
        return None
    return real


def png_size(path: Path) -> tuple[int, int] | None:
    try:
        with path.open("rb") as handle:
            head = handle.read(24)
    except OSError:
        return None
    if len(head) < 24 or head[:8] != PNG_SIGNATURE or head[12:16] != b"IHDR":
        return None
    width, height = struct.unpack(">II", head[16:24])
    return width, height


def repo_relative_dir(directory: Any) -> str | None:
    """artifacts_dir is repo-relative by contract; accept an absolute path inside the repo too."""
    if not isinstance(directory, str) or not directory:
        return None
    path = Path(directory)
    if path.is_absolute():
        try:
            return path.resolve().relative_to(ROOT).as_posix()
        except (OSError, ValueError):
            return None
    return path.as_posix()


def artifact_ref(artifacts_dir: str | None, name: Any) -> dict[str, Any] | None:
    """A browser URL (plus pixel size) for one artifact PNG, or None if it is missing/unsafe."""
    if not artifacts_dir or not isinstance(name, str) or not name:
        return None
    relative = f"{artifacts_dir.rstrip('/')}/{name}"
    path = safe_artifact(relative)
    if path is None:
        return None
    size = png_size(path)
    try:
        version = int(path.stat().st_mtime)
    except OSError:
        return None
    return {
        "url": f"/api/artifact?path={quote(relative)}&v={version}",
        "path": relative,
        "width": size[0] if size else None,
        "height": size[1] if size else None,
    }


def display_source(value: Any, target_app: Any = None) -> str:
    """Show ``file:///<repo>/demo/index.html`` as ``demo/index.html``; leave anything else alone.

    A file URI recorded by another checkout of this repository is shown as the
    scan's ``target_app`` only when it names exactly that repo-relative file.
    """
    text = str(value) if value else "—"
    if not text.startswith("file://"):
        return text
    path = Path(unquote(urlparse(text).path))
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except (OSError, ValueError):
        pass
    target = str(target_app or "")
    if target and not Path(target).is_absolute() and path.as_posix().endswith(f"/{target}"):
        return target
    return text


def finding_source(violation: dict[str, Any]) -> str:
    # Scans recorded before the vision stage have no ``source``: they are DOM findings.
    return "vision" if violation.get("source") == "vision" else "axe"


def number_or_none(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def wcag_criteria(tags: Any) -> list[str]:
    """``wcag247`` -> ``2.4.7`` (level tags such as ``wcag2aa`` are skipped)."""
    criteria = []
    for tag in tags or []:
        digits = str(tag)[4:] if str(tag).startswith("wcag") else ""
        if digits.isdigit() and len(digits) >= 3:
            criteria.append(f"{digits[0]}.{digits[1]}.{digits[2:]}")
    return criteria


def gate_list(results: Any) -> list[dict[str, str]] | None:
    if not isinstance(results, dict) or not results:
        return None
    names = [name for name in GATE_ORDER if name in results] + sorted(set(results) - set(GATE_ORDER))
    return [{"name": name, "status": str(results[name])} for name in names]


def vision_read_model(audit: Any, vision_findings: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Trimmed view of ``scans.vision_audit`` with artifact paths resolved to URLs."""
    if not isinstance(audit, dict):
        return None
    artifacts_dir = repo_relative_dir(audit.get("artifacts_dir"))
    model = audit.get("model") or {}
    tasks = [task for task in audit.get("tasks") or [] if isinstance(task, dict)]
    cache = audit.get("cache") or {}
    counts = audit.get("counts") or {}
    capture = audit.get("capture") or {}
    reflow = capture.get("reflow") or {}
    review = audit.get("design_review") if isinstance(audit.get("design_review"), dict) else None
    annotated_names = audit.get("annotated") or {}

    task_rows = []
    for task in tasks:
        stats = task.get("stats") or {}
        task_rows.append({
            "name": task.get("name"),
            "think": bool(task.get("think")),
            "images": task.get("images"),
            "status": task.get("status"),
            "cached": bool(task.get("cached")),
            "cachedAt": task.get("cached_at"),
            "latencyS": number_or_none(stats.get("latency_s")),
            "promptTokens": stats.get("prompt_tokens"),
            "outputTokens": stats.get("output_tokens"),
            "error": task.get("error"),
        })
    cached_times = sorted(str(task["cachedAt"]) for task in task_rows if task["cached"] and task["cachedAt"])
    thinking = [task["think"] for task in task_rows]

    annotated: dict[str, Any] = {}
    missing: list[str] = []
    for key, out_key in (("desktop", "desktop"), ("reflow-320", "reflow320"), ("design", "design")):
        name = annotated_names.get(key)
        ref = artifact_ref(artifacts_dir, name)
        annotated[out_key] = ref
        if name and ref is None:
            missing.append(str(name))

    improvements = []
    for index, item in enumerate((review or {}).get("improvements") or [], start=1):
        if not isinstance(item, dict):
            continue
        improvements.append({
            "number": item.get("number") or index,
            "area": item.get("area"),
            "priority": item.get("priority"),
            "issue": item.get("issue"),
            "recommendation": item.get("recommendation"),
            "cssSuggestion": item.get("css_suggestion"),
            "accessibilityBenefit": item.get("accessibility_benefit"),
            "selector": item.get("selector"),
            "visibleText": item.get("visible_text"),
            "grounding": item.get("grounding"),
            "image": artifact_ref(artifacts_dir, item.get("image")),
        })
    scores = (review or {}).get("scores") or {}
    by_viewport: dict[str, int] = {}
    for finding in vision_findings:
        viewport = (finding.get("vision") or {}).get("viewport") or "unknown"
        by_viewport[viewport] = by_viewport.get(viewport, 0) + 1

    def trimmed(items: Any, keys: tuple[str, ...]) -> list[dict[str, Any]]:
        return [{key: item.get(key) for key in keys} for item in items or [] if isinstance(item, dict)]

    return {
        "status": audit.get("status") or "unknown",
        "error": audit.get("error") or audit.get("reason"),
        "engine": {
            "name": (audit.get("engine") or {}).get("name"),
            "promptVersion": (audit.get("engine") or {}).get("prompt_version"),
        },
        "model": {
            "name": model.get("model"),
            "baseModel": model.get("base_model"),
            "numCtx": model.get("num_ctx"),
            "parameterSize": model.get("parameter_size"),
            "quantization": model.get("quantization"),
            "capabilities": model.get("capabilities") or [],
        } if model else None,
        "thinking": ("on" if all(thinking) else "partial" if any(thinking) else "off") if thinking else None,
        "sampling": audit.get("sampling"),
        "startedAt": audit.get("started_at"),
        "finishedAt": audit.get("finished_at"),
        "latencyS": number_or_none(audit.get("latency_s")),
        "calls": {
            "total": len(task_rows),
            "ok": sum(1 for task in task_rows if task["status"] == "ok"),
            "failed": sum(1 for task in task_rows if task["status"] != "ok"),
            "cached": sum(1 for task in task_rows if task["cached"]),
            "outputTokens": sum(task["outputTokens"] or 0 for task in task_rows if isinstance(task["outputTokens"], int)),
        },
        "tasks": task_rows,
        "cache": {
            "enabled": cache.get("enabled"),
            "hits": cache.get("hits"),
            "calls": cache.get("calls"),
            "allCached": bool(cache.get("all_cached")),
            "cachedFrom": cached_times[0] if cached_times else None,
            "cachedTo": cached_times[-1] if cached_times else None,
        } if cache else None,
        "counts": {
            "findings": counts.get("findings", len(vision_findings)),
            "byCategory": counts.get("by_category") or {},
            "byViewport": by_viewport,
            "suppressed": counts.get("suppressed", len(audit.get("suppressed") or [])),
            "deduplicated": counts.get("deduplicated", len(audit.get("deduplicated") or [])),
        },
        "capture": {
            "captureMs": capture.get("capture_ms"),
            "viewports": [
                {"id": vp.get("id"), "width": vp.get("width"), "pageHeight": vp.get("page_height"), "regions": vp.get("regions")}
                for vp in capture.get("viewports") or [] if isinstance(vp, dict)
            ],
            "focusStops": capture.get("focus_stops"),
            "contrastCandidates": capture.get("contrast_candidates"),
            "targetCandidates": capture.get("target_candidates"),
            "reflow": {
                "horizontalOverflowPx": reflow.get("horizontal_overflow_px"),
                "hiddenAtReflow": trimmed(reflow.get("hidden_at_reflow"), ("selector", "text", "interactive")),
                "overflowing": len(reflow.get("overflowing") or []),
            } if reflow else None,
        } if capture else None,
        "designReview": {
            "summary": review.get("summary"),
            "strengths": [str(item) for item in review.get("strengths") or []],
            "improvements": improvements,
            "scores": {key: number_or_none(scores.get(key)) for key in ("overall", "typography", "color", "spacing", "hierarchy")},
            "overallScore": number_or_none(review.get("overall_score", scores.get("overall"))),
        } if review else None,
        "annotated": annotated,
        "missingArtifacts": missing,
        "artifactsDir": artifacts_dir,
        "deduplicated": trimmed(audit.get("deduplicated"), ("category", "selector", "reason", "title")),
        "suppressed": trimmed(audit.get("suppressed"), ("category", "selector", "confidence", "reason", "title")),
    }


def heartbeat_data() -> dict[str, Any]:
    """Return only timestamps written by the independent watcher process."""
    if not HEARTBEAT.exists():
        return {"status": "not started"}
    try:
        return json.loads(HEARTBEAT.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"status": "unavailable"}


def local_demo_data(error: str) -> dict[str, Any]:
    """Surface the real local axe result when persistence is unavailable.

    This is deliberately marked as non-persisted: it is a usable visual
    fallback, never a stand-in for a MongoDB record.
    """
    violations: list[dict[str, Any]] = []
    scanned_at: datetime | None = None
    if LOCAL_DEMO_REPORT.exists():
        try:
            report = json.loads(LOCAL_DEMO_REPORT.read_text(encoding="utf-8"))
            violations = list(report.get("violations", []))
            scanned_at = datetime.fromtimestamp(LOCAL_DEMO_REPORT.stat().st_mtime, timezone.utc)
        except (OSError, json.JSONDecodeError):
            pass
    count = sum(len(item.get("nodes", [])) for item in violations)
    return {
        "connection": "unavailable",
        "error": error,
        "isFallback": True,
        "summary": {"sitesMonitored": 1 if scanned_at else 0, "fixesLogged": 0},
        "activity": {"active": False, "stage": "idle"},
        "sites": ([{
            "targetApp": "demo/index.html",
            "lastScan": scanned_at,
            "violationCount": count,
            "status": "clean" if count == 0 else "open violations",
            "triggerSource": "local scan",
        }] if scanned_at else []),
    }


def local_demo_site(error: str) -> dict[str, Any] | None:
    if not LOCAL_DEMO_REPORT.exists():
        return None
    try:
        report = json.loads(LOCAL_DEMO_REPORT.read_text(encoding="utf-8"))
        scanned_at = datetime.fromtimestamp(LOCAL_DEMO_REPORT.stat().st_mtime, timezone.utc)
    except (OSError, json.JSONDecodeError):
        return None
    findings = [
        {
            "ruleId": violation.get("id", "unknown-rule"),
            "selector": " ".join(node.get("target", [])) or "unknown selector",
            "severity": violation.get("impact") or "unknown",
            "sourceFile": "demo/index.html",
            "fixStatus": "pending",
            "originalSnippet": None,
            "patchedSnippet": None,
        }
        for violation in report.get("violations", [])
        for node in violation.get("nodes", [])
    ]
    return {
        "targetApp": "demo/index.html",
        "latestScan": scanned_at,
        "violations": findings,
        "history": [{"timestamp": scanned_at, "violationCount": len(findings)}],
        "accessPoints": ["demo/index.html"],
        "activity": {"active": False, "stage": "idle"},
        "nonPersisted": True,
        "storeError": error,
    }


def is_recent(value: Any) -> bool:
    if not isinstance(value, datetime):
        return False
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - value.astimezone(timezone.utc)).total_seconds() <= ACTIVE_WINDOW_SECONDS


def event_for_scan(events: list[dict[str, Any]], scan_id: Any) -> list[dict[str, Any]]:
    scan_key = identifier(scan_id)
    return [
        event
        for event in events
        if identifier(event.get("details", {}).get("scan_id")) == scan_key
    ]


def event_order(event: dict[str, Any]) -> tuple[datetime, str]:
    """Newest-first key.  Stage events of one run can share a millisecond timestamp
    (e.g. ``scan`` and ``vision``), so ties fall back to the ObjectId, which grows
    with insertion order within a process."""
    stamp = event.get("timestamp")
    if not isinstance(stamp, datetime):
        stamp = datetime.min
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp, identifier(event.get("_id"))


def audit_stage(events: list[dict[str, Any]], scan_id: Any | None = None) -> dict[str, Any]:
    relevant = event_for_scan(events, scan_id) if scan_id is not None else events
    relevant = sorted(relevant, key=event_order, reverse=True)
    latest = relevant[0] if relevant else None
    event_type = latest.get("event_type") if latest else None
    stage_for_event = {"scan_run": "scan", "patch_applied": "patch", "verified": "verify"}
    details = latest.get("details", {}) if latest else {}
    stage = details.get("stage") or stage_for_event.get(event_type, "idle")
    active = bool(latest and not details.get("complete") and is_recent(latest.get("timestamp")))
    return {
        "stage": stage if active else "idle",
        "active": active,
        "latestEvent": event_type,
        "triggerSource": details.get("trigger_source"),
        "timestamp": latest.get("timestamp") if latest else None,
        "events": relevant,
    }


def open_store() -> MongoStore:
    store = MongoStore(server_selection_timeout_ms=2500)
    store.ping()
    return store


def dashboard_data() -> dict[str, Any]:
    store = open_store()
    try:
        scans = store.find_scans()
        patches = store.find_patches()
        events = store.find_audit_events(limit=100)
        newest_by_target: dict[str, dict[str, Any]] = {}
        for scan in scans:
            target = str(scan.get("target_app", "Unnamed target"))
            newest_by_target.setdefault(target, scan)

        sites = []
        for target, scan in newest_by_target.items():
            flow = audit_stage(events, scan.get("_id"))
            findings = scan.get("violations", [])
            count = len(findings)
            vision_count = sum(1 for violation in findings if finding_source(violation) == "vision")
            vision_audit = scan.get("vision_audit") if isinstance(scan.get("vision_audit"), dict) else None
            status = "in progress" if flow["active"] else ("clean" if count == 0 else "open violations")
            sites.append({
                "targetApp": target,
                "scanId": identifier(scan.get("_id")),
                "lastScan": scan.get("timestamp"),
                "violationCount": count,
                "axeCount": count - vision_count,
                "visionCount": vision_count,
                "visionStatus": vision_audit.get("status") if vision_audit else None,
                "status": status,
                "triggerSource": flow.get("triggerSource"),
            })
        return {
            "connection": "connected",
            "summary": {
                "sitesMonitored": len(newest_by_target),
                "fixesLogged": len(patches),
            },
            "activity": audit_stage(events),
            "sites": sites,
        }
    finally:
        store.close()


def site_data(target_app: str) -> dict[str, Any] | None:
    store = open_store()
    try:
        scans = store.find_scans({"target_app": target_app})
        if not scans:
            return None
        patches = store.find_patches()
        events = store.find_audit_events(limit=300)
        latest = scans[0]
        linked_patches = [
            patch for patch in patches if identifier(patch.get("scan_id")) == identifier(latest.get("_id"))
        ]
        patches_by_finding = {
            (str(patch.get("violation_rule_id", "")), str(patch.get("source_file", ""))): patch
            for patch in linked_patches
        }
        gates_by_patch: dict[str, Any] = {}
        for event in events:  # newest first: keep the latest verified record per patch
            details = event.get("details", {})
            if event.get("event_type") == "verified" and details.get("patch_id"):
                gates_by_patch.setdefault(identifier(details.get("patch_id")), details)
        vision_audit = latest.get("vision_audit") if isinstance(latest.get("vision_audit"), dict) else None
        artifacts_dir = repo_relative_dir(vision_audit.get("artifacts_dir")) if vision_audit else None
        violations = []
        vision_findings = []
        for index, violation in enumerate(latest.get("violations", [])):
            source = finding_source(violation)
            is_vision = source == "vision"
            # Vision findings are recorded for review, never auto-patched: an axe patch
            # for the same file must not mark them verified.
            patch = None if is_vision else patches_by_finding.get(
                (str(violation.get("rule_id", "")), str(violation.get("source_file", "")))
            )
            gate_record = gates_by_patch.get(identifier(patch.get("_id"))) if patch else None
            vision = violation.get("vision") if isinstance(violation.get("vision"), dict) else {}
            entry: dict[str, Any] = {
                "id": f"finding-{index}",
                "ruleId": violation.get("rule_id", "—"),
                "selector": violation.get("selector", "—"),
                "severity": violation.get("severity", "unknown"),
                "sourceFile": display_source(violation.get("source_file"), latest.get("target_app")),
                "source": source,
                "scanner": violation.get("scanner"),
                "confidence": number_or_none(violation.get("confidence")),
                "description": violation.get("description"),
                "help": violation.get("help"),
                "helpUrl": violation.get("help_url"),
                "evidence": violation.get("failure_summary"),
                "wcag": wcag_criteria(violation.get("wcag_tags") or violation.get("tags")),
                "fixStatus": "review" if is_vision else ("verified" if patch and patch.get("verified") else "pending"),
                "originalSnippet": patch.get("original_snippet") if patch else None,
                "patchedSnippet": patch.get("patched_snippet") if patch else None,
                "gates": gate_list(gate_record.get("gate_results")) if gate_record else None,
                "gatesNote": gate_record.get("gates_note") if gate_record else None,
            }
            if is_vision:
                vision_findings.append(violation)
                entry.update({
                    "number": vision.get("number") or len(vision_findings),
                    "category": vision.get("category") or str(violation.get("rule_id", "")).removeprefix("vision-"),
                    "method": vision.get("method"),
                    "grounding": vision.get("grounding"),
                    "viewport": vision.get("viewport"),
                    "elementText": vision.get("element_text"),
                    "evidenceImage": artifact_ref(artifacts_dir, vision.get("evidence_image")),
                    "modelImage": artifact_ref(artifacts_dir, vision.get("image")),
                    "imagesDeclared": [name for name in (vision.get("evidence_image"), vision.get("image")) if name],
                })
            violations.append(entry)
        access_points = sorted({
            display_source(violation.get("source_file"), scan.get("target_app"))
            for scan in scans
            for violation in scan.get("violations", [])
            if violation.get("source_file")
        })
        return {
            "targetApp": target_app,
            "latestScan": latest.get("timestamp"),
            "violations": violations,
            "history": [
                {
                    "timestamp": scan.get("timestamp"),
                    "violationCount": len(scan.get("violations", [])),
                    "visionCount": sum(1 for v in scan.get("violations", []) if finding_source(v) == "vision"),
                    "visionStatus": (scan.get("vision_audit") or {}).get("status") if isinstance(scan.get("vision_audit"), dict) else None,
                }
                for scan in reversed(scans)
            ],
            "accessPoints": access_points,
            "activity": audit_stage(events, latest.get("_id")),
            "visionAudit": vision_read_model(vision_audit, vision_findings),
        }
    finally:
        store.close()


def report_html(target_app: str) -> str | None:
    module_path = ROOT / "audit-report" / "generate_report.py"
    spec = importlib.util.spec_from_file_location("guardrail_audit_report", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load audit-report/generate_report.py")
    report = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(report)
    store = MongoStore(server_selection_timeout_ms=3000)
    try:
        data = report.collect(store, None, target_app=target_app)
        database = store.database.name
    except LookupError:
        return None
    finally:
        store.close()
    return report.render_html(data, database)


class GuardRailHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(DASHBOARD_DIR), **kwargs)

    def send_header(self, keyword: str, value: str) -> None:
        if keyword.lower() == "cache-control":
            self._cache_control_sent = True
        super().send_header(keyword, value)

    def end_headers(self) -> None:
        if not getattr(self, "_cache_control_sent", False):
            self.send_header("Cache-Control", "no-store")
        self._cache_control_sent = False
        super().end_headers()

    def send_artifact(self, query: str) -> None:
        values = parse_qs(query).get("path", [])
        path = safe_artifact(values[0]) if len(values) == 1 else None
        try:
            content = path.read_bytes() if path else b""
        except OSError:
            content = b""
        if not content.startswith(PNG_SIGNATURE):
            self.send_error(HTTPStatus.NOT_FOUND, "Artifact not found")
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", ARTIFACT_CACHE_CONTROL)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(content)

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, default=json_value).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/dashboard":
            try:
                self.send_json(HTTPStatus.OK, dashboard_data())
            except Exception as error:  # The UI needs the truth if Mongo is unavailable.
                self.send_json(HTTPStatus.OK, local_demo_data(str(error)))
            return
        if parsed.path == "/api/heartbeat":
            self.send_json(HTTPStatus.OK, heartbeat_data())
            return
        if parsed.path == "/api/artifact":
            self.send_artifact(parsed.query)
            return
        if parsed.path == "/api/site":
            target = parse_qs(parsed.query).get("target", [""])[0]
            try:
                payload = site_data(target)
                self.send_json(HTTPStatus.OK if payload else HTTPStatus.NOT_FOUND, payload or {"error": "Site not found"})
            except Exception as error:
                fallback = local_demo_site(str(error)) if target == "demo/index.html" else None
                self.send_json(HTTPStatus.OK if fallback else HTTPStatus.SERVICE_UNAVAILABLE, fallback or {"connection": "unavailable", "error": str(error)})
            return
        if parsed.path == "/api/report":
            target = parse_qs(parsed.query).get("target", [""])[0]
            try:
                report = report_html(target)
                if report is None:
                    self.send_error(HTTPStatus.NOT_FOUND, "Site not found")
                    return
                content = report.encode("utf-8")
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                self.wfile.write(content)
            except Exception as error:
                self.send_error(HTTPStatus.SERVICE_UNAVAILABLE, f"Report unavailable: {error}")
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/api/scan":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(content_length) or b"{}")
            target = str(payload.get("target", "")).strip()
            if not target:
                raise ValueError("A target file path or URL is required")

            def execute() -> None:
                try:
                    run_pipeline(target, "manual")
                except Exception:
                    # The watcher heartbeat/error surface remains the honest
                    # state when persistence is unavailable; don't crash a
                    # request thread or fabricate a successful run.
                    return

            threading.Thread(target=execute, daemon=True, name="guardrail-manual-scan").start()
            self.send_json(HTTPStatus.ACCEPTED, {"status": "queued", "target_app": target, "trigger_source": "manual"})
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})


def start_watcher() -> subprocess.Popen[str] | None:
    if os.getenv("GUARDRAIL_START_WATCHER", "1") != "1":
        return None
    return subprocess.Popen([sys.executable, "-m", "pipeline.watcher"], cwd=ROOT)


if __name__ == "__main__":
    print(f"GuardRail dashboard listening on http://127.0.0.1:{PORT}")
    print("MongoDB URI and database are read from MONGODB_URI and MONGODB_DATABASE.")
    watcher = start_watcher()
    try:
        ThreadingHTTPServer(("127.0.0.1", PORT), GuardRailHandler).serve_forever()
    finally:
        if watcher:
            watcher.terminate()
