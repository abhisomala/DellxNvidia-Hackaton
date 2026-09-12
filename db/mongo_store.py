"""Small PyMongo repository for the draft scanner persistence schema.

The violations field is deliberately represented as a list of mappings.  Only
the currently agreed core keys are checked; extra keys are stored unchanged so
the violation-detection producer can evolve without a migration here.
"""

from __future__ import annotations

import os
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from typing import Any

from bson import ObjectId
from pymongo import ASCENDING, DESCENDING, MongoClient
from pymongo.collection import Collection
from pymongo.database import Database

DEFAULT_MONGODB_URI = "mongodb://localhost:27017"
DEFAULT_DATABASE_NAME = "scanner"
AUDIT_EVENT_TYPES = frozenset({"scan_run", "patch_applied", "verified"})

# Keep this one shallow list as the scanner team's output contract evolves.
VIOLATION_CORE_FIELDS = (
    "rule_id",
    "selector",
    "severity",
    "description",
    "source_file",
)


def utc_now() -> datetime:
    """Return a timezone-aware UTC timestamp suitable for new records."""
    return datetime.now(timezone.utc)


def _as_object_id(value: ObjectId | str, field_name: str) -> ObjectId:
    if isinstance(value, ObjectId):
        return value
    if isinstance(value, str) and ObjectId.is_valid(value):
        return ObjectId(value)
    raise ValueError(f"{field_name} must be a BSON ObjectId or a valid ObjectId string")


def _normalise_violations(violations: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Validate agreed keys while preserving any future producer-specific keys."""
    normalised: list[dict[str, Any]] = []
    for index, violation in enumerate(violations):
        if not isinstance(violation, Mapping):
            raise TypeError(f"violations[{index}] must be a mapping")
        missing = [key for key in VIOLATION_CORE_FIELDS if key not in violation]
        if missing:
            raise ValueError(f"violations[{index}] is missing required keys: {', '.join(missing)}")
        normalised.append(dict(violation))
    return normalised


class MongoStore:
    """Insert and query the scans, patches, and audit_log collections.

    ``uri`` defaults to ``MONGODB_URI`` and then the local MongoDB default.
    ``database_name`` defaults to ``MONGODB_DATABASE`` and then ``scanner``.
    Passing a client is useful for tests; the caller then owns that client.
    """

    def __init__(
        self,
        uri: str | None = None,
        database_name: str | None = None,
        *,
        client: MongoClient | None = None,
        server_selection_timeout_ms: int | None = None,
    ) -> None:
        self._owns_client = client is None
        options: dict[str, Any] = {"tz_aware": True}
        if server_selection_timeout_ms is not None:
            options["serverSelectionTimeoutMS"] = server_selection_timeout_ms
        self.client = client or MongoClient(
            uri or os.getenv("MONGODB_URI", DEFAULT_MONGODB_URI), **options
        )
        self.database: Database = self.client[
            database_name or os.getenv("MONGODB_DATABASE", DEFAULT_DATABASE_NAME)
        ]
        self.scans: Collection = self.database["scans"]
        self.patches: Collection = self.database["patches"]
        self.audit_log: Collection = self.database["audit_log"]

    def close(self) -> None:
        if self._owns_client:
            self.client.close()

    def ping(self) -> None:
        """Raise PyMongo's connection error when the configured server is unavailable."""
        self.client.admin.command("ping")

    def ensure_indexes(self) -> None:
        """Create non-unique indexes for common lookup paths."""
        self.scans.create_index([("timestamp", DESCENDING)])
        self.scans.create_index([("target_app", ASCENDING)])
        self.patches.create_index([("scan_id", ASCENDING)])
        self.patches.create_index([("verification_scan_id", ASCENDING)])
        self.patches.create_index([("violation_rule_id", ASCENDING)])
        self.audit_log.create_index([("event_type", ASCENDING), ("timestamp", DESCENDING)])

    # scans: {_id, timestamp, target_app, violations: [{...}]}
    def insert_scan(
        self,
        target_app: str,
        violations: Sequence[Mapping[str, Any]],
        *,
        timestamp: datetime | None = None,
    ) -> ObjectId:
        document = {
            "timestamp": timestamp or utc_now(),
            "target_app": target_app,
            "violations": _normalise_violations(violations),
        }
        return self.scans.insert_one(document).inserted_id

    def get_scan(self, scan_id: ObjectId | str) -> dict[str, Any] | None:
        return self.scans.find_one({"_id": _as_object_id(scan_id, "scan_id")})

    def find_scans(
        self, filters: Mapping[str, Any] | None = None, *, limit: int | None = None
    ) -> list[dict[str, Any]]:
        cursor = self.scans.find(dict(filters or {})).sort("timestamp", DESCENDING)
        if limit is not None:
            cursor = cursor.limit(limit)
        return list(cursor)

    # patches: {_id, scan_id, violation_rule_id, source_file, ...}
    def insert_patch(
        self,
        scan_id: ObjectId | str,
        violation_rule_id: str,
        source_file: str,
        original_snippet: str,
        patched_snippet: str,
        model_used: str,
        *,
        applied_at: datetime | None = None,
        verified: bool = False,
        verification_scan_id: ObjectId | str | None = None,
    ) -> ObjectId:
        if not isinstance(verified, bool):
            raise TypeError("verified must be a bool")
        document = {
            "scan_id": _as_object_id(scan_id, "scan_id"),
            "violation_rule_id": violation_rule_id,
            "source_file": source_file,
            "original_snippet": original_snippet,
            "patched_snippet": patched_snippet,
            "model_used": model_used,
            "applied_at": applied_at or utc_now(),
            "verified": verified,
            "verification_scan_id": (
                _as_object_id(verification_scan_id, "verification_scan_id")
                if verification_scan_id is not None
                else None
            ),
        }
        return self.patches.insert_one(document).inserted_id

    def get_patch(self, patch_id: ObjectId | str) -> dict[str, Any] | None:
        return self.patches.find_one({"_id": _as_object_id(patch_id, "patch_id")})

    def find_patches(
        self, filters: Mapping[str, Any] | None = None, *, limit: int | None = None
    ) -> list[dict[str, Any]]:
        cursor = self.patches.find(dict(filters or {})).sort("applied_at", DESCENDING)
        if limit is not None:
            cursor = cursor.limit(limit)
        return list(cursor)

    # audit_log: {_id, event_type, timestamp, details}
    def insert_audit_event(
        self,
        event_type: str,
        details: Mapping[str, Any],
        *,
        timestamp: datetime | None = None,
    ) -> ObjectId:
        if event_type not in AUDIT_EVENT_TYPES:
            allowed = ", ".join(sorted(AUDIT_EVENT_TYPES))
            raise ValueError(f"event_type must be one of: {allowed}")
        return self.audit_log.insert_one(
            {
                "event_type": event_type,
                "timestamp": timestamp or utc_now(),
                "details": dict(details),
            }
        ).inserted_id

    def get_audit_event(self, event_id: ObjectId | str) -> dict[str, Any] | None:
        return self.audit_log.find_one({"_id": _as_object_id(event_id, "event_id")})

    def find_audit_events(
        self, filters: Mapping[str, Any] | None = None, *, limit: int | None = None
    ) -> list[dict[str, Any]]:
        cursor = self.audit_log.find(dict(filters or {})).sort("timestamp", DESCENDING)
        if limit is not None:
            cursor = cursor.limit(limit)
        return list(cursor)
