#!/usr/bin/env python3
"""Local GuardRail dashboard server backed by the scanner's MongoDB collections.

Run with ``python3 dashboard_server.py``.  The API deliberately exposes only
derived read models; the browser never receives a MongoDB credential.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import threading
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from bson import ObjectId

from db.mongo_store import MongoStore
from pipeline.run_pipeline import run_pipeline


ROOT = Path(__file__).resolve().parent
DASHBOARD_DIR = ROOT / "dashboard"
PORT = int(os.getenv("GUARDRAIL_PORT", "4173"))
ACTIVE_WINDOW_SECONDS = 15 * 60
HEARTBEAT = ROOT / "runtime" / "heartbeat.json"
LOCAL_DEMO_REPORT = ROOT / "reports" / "a11y-report.json"


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


def audit_stage(events: list[dict[str, Any]], scan_id: Any | None = None) -> dict[str, Any]:
    relevant = event_for_scan(events, scan_id) if scan_id is not None else events
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
            count = len(scan.get("violations", []))
            status = "in progress" if flow["active"] else ("clean" if count == 0 else "open violations")
            sites.append({
                "targetApp": target,
                "scanId": identifier(scan.get("_id")),
                "lastScan": scan.get("timestamp"),
                "violationCount": count,
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
        violations = []
        for violation in latest.get("violations", []):
            patch = patches_by_finding.get((str(violation.get("rule_id", "")), str(violation.get("source_file", ""))))
            violations.append({
                "ruleId": violation.get("rule_id", "—"),
                "selector": violation.get("selector", "—"),
                "severity": violation.get("severity", "unknown"),
                "sourceFile": violation.get("source_file", "—"),
                "fixStatus": "verified" if patch and patch.get("verified") else "pending",
                "originalSnippet": patch.get("original_snippet") if patch else None,
                "patchedSnippet": patch.get("patched_snippet") if patch else None,
            })
        access_points = sorted({
            str(violation.get("source_file"))
            for scan in scans
            for violation in scan.get("violations", [])
            if violation.get("source_file")
        })
        return {
            "targetApp": target_app,
            "latestScan": latest.get("timestamp"),
            "violations": violations,
            "history": [
                {"timestamp": scan.get("timestamp"), "violationCount": len(scan.get("violations", []))}
                for scan in reversed(scans)
            ],
            "accessPoints": access_points,
            "activity": audit_stage(events, latest.get("_id")),
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
    try:
        scan, patches, events = report.load_audit_data(target_app)
    except LookupError:
        return None
    return report.build_report(scan, patches, events)


class GuardRailHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(DASHBOARD_DIR), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

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
