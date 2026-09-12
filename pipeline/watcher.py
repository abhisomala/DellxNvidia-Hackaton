#!/usr/bin/env python3
"""Always-on, local GuardRail watcher independent of dashboard interactions."""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

from pipeline.run_pipeline import ROOT, run_pipeline


RUNTIME = ROOT / "runtime"
HEARTBEAT = RUNTIME / "heartbeat.json"
INTERVAL = max(10, int(os.getenv("GUARDRAIL_WATCH_INTERVAL_SECONDS", "60")))
TARGET = os.getenv("GUARDRAIL_WATCH_TARGET", str(ROOT / "demo" / "index.html"))


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_heartbeat(**values: object) -> None:
    RUNTIME.mkdir(exist_ok=True)
    temporary = HEARTBEAT.with_suffix(".tmp")
    temporary.write_text(json.dumps(values), encoding="utf-8")
    temporary.replace(HEARTBEAT)


def main() -> None:
    watching_since = now()
    while True:
        started_at = now()
        write_heartbeat(watching_since=watching_since, interval_seconds=INTERVAL, next_scan_at=started_at, last_run=started_at, status="running")
        try:
            result = run_pipeline(TARGET, "automatic")
            state = {"status": "watching", "last_result": result}
        except Exception as error:
            state = {"status": "waiting", "last_error": str(error)}
        next_scan = datetime.now(timezone.utc).timestamp() + INTERVAL
        write_heartbeat(watching_since=watching_since, interval_seconds=INTERVAL, next_scan_at=datetime.fromtimestamp(next_scan, timezone.utc).isoformat(), last_run=started_at, **state)
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
