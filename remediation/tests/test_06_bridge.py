"""
remediation/bridge/record_to_mongo.py — records a finished fix into the team MongoDB.

Driven as a subprocess with a STUB db.mongo_store injected via --repo-root, so the
real contract (argument handling, exit codes, what gets inserted) is exercised
without needing a MongoDB server.
"""
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

# tests/ -> remediation/ -> repo root
REMEDIATION = Path(__file__).resolve().parent.parent
REPO = REMEDIATION.parent
BRIDGE = REMEDIATION / "bridge" / "record_to_mongo.py"
REAL_STORE = REPO / "db" / "mongo_store.py"

# A report.json exactly as src/fix.mjs finish() writes it.
def make_report(status="fixed", scan_id=None, **over):
    r = {
        "violation_id": "button-name#0",
        "rule_id": "button-name",
        "selector": "#upload-submit",
        "status": status,
        "attempts": [{"attempt": 1, "agent_ok": True}],
        "mongo_patch": {
            "scan_id": scan_id,
            "target_app": "portal",
            "violation_rule_id": "button-name",
            "source_file": "src/components/UploadButton.jsx",
            "original_snippet": '      <button id="upload-submit" className="icon-btn" onClick={handleUpload}>',
            "patched_snippet": '      <button id="upload-submit" aria-label="Upload assignment" className="icon-btn" onClick={handleUpload}>',
            "model_used": "openclaw-agent",
            "verified": status == "fixed",
            "violation_for_scans": {
                "rule_id": "button-name",
                "selector": "#upload-submit",
                "severity": "critical",
                "description": "Buttons must have discernible text",
                "source_file": "src/components/UploadButton.jsx",
                "html": '<button id="upload-submit"></button>',
            },
        },
    }
    r.update(over)
    return r


STUB_STORE = textwrap.dedent('''
    """Stub stand-in for the teammate's db.mongo_store, recording calls to a JSON file."""
    import json, os

    LOG = os.environ["STUB_LOG"]
    MODE = os.environ.get("STUB_MODE", "ok")

    def _log(entry):
        data = []
        if os.path.exists(LOG):
            data = json.loads(open(LOG).read())
        data.append(entry)
        open(LOG, "w").write(json.dumps(data, default=str))

    class MongoStore:
        def __init__(self, *a, **kw):
            _log({"call": "__init__", "kwargs": {k: str(v) for k, v in kw.items()}})
            if MODE == "ctor_raises":
                from pymongo.errors import ConfigurationError
                raise ConfigurationError("bad URI")
        def ping(self):
            _log({"call": "ping"})
            if MODE == "down":
                from pymongo.errors import ServerSelectionTimeoutError
                raise ServerSelectionTimeoutError("no server")
        def insert_scan(self, target_app, violations, **kw):
            _log({"call": "insert_scan", "target_app": target_app, "violations": list(violations)})
            return "SCANID"
        def insert_patch(self, **kw):
            _log({"call": "insert_patch", "kwargs": {k: str(v) for k, v in kw.items()}})
            if MODE == "patch_raises":
                from pymongo.errors import OperationFailure
                raise OperationFailure("write failed")
            if MODE == "objectid_raises":
                raise ValueError("scan_id must be a BSON ObjectId or a valid ObjectId string")
            return "PATCHID"
        def insert_audit_event(self, event_type, details, **kw):
            _log({"call": "insert_audit_event", "event_type": event_type, "details": details})
            return "EVENTID"
        def close(self):
            _log({"call": "close"})
''')


class BridgeCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="a11y-bridge-test-")
        self.root = Path(self.tmp.name)
        (self.root / "db").mkdir()
        (self.root / "db" / "__init__.py").write_text("")
        (self.root / "db" / "mongo_store.py").write_text(STUB_STORE)
        self.log = self.root / "calls.json"

    def tearDown(self):
        self.tmp.cleanup()

    def run_bridge(self, report, extra=(), mode="ok", report_name="report.json"):
        p = self.root / report_name
        if report is not None:
            p.write_text(json.dumps(report) if isinstance(report, dict) else report)
        env = {**os.environ, "STUB_LOG": str(self.log), "STUB_MODE": mode}
        proc = subprocess.run(
            [sys.executable, str(BRIDGE), str(p), "--repo-root", str(self.root), *extra],
            capture_output=True, text=True, env=env, timeout=60,
        )
        calls = json.loads(self.log.read_text()) if self.log.exists() else []
        return proc, calls

    # ── MAIN ────────────────────────────────────────────────────────────────
    def test_main_records_a_verified_fix(self):
        proc, calls = self.run_bridge(make_report())
        self.assertEqual(proc.returncode, 0, proc.stderr)
        names = [c["call"] for c in calls]
        self.assertIn("insert_patch", names)
        self.assertIn("close", names)
        patch = next(c for c in calls if c["call"] == "insert_patch")
        self.assertEqual(patch["kwargs"]["violation_rule_id"], "button-name")
        self.assertEqual(patch["kwargs"]["verified"], "True")
        events = [c for c in calls if c["call"] == "insert_audit_event"]
        self.assertEqual({e["event_type"] for e in events}, {"patch_applied", "verified"})

    def test_dry_run_writes_nothing_and_prints_documents(self):
        proc, calls = self.run_bridge(make_report(), extra=["--dry-run"])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(calls, [], "--dry-run must not construct a store or insert anything")
        out = json.loads(proc.stdout)
        self.assertIn("patch", out)
        self.assertIn("audit_events", out)

    def test_missing_scan_id_creates_a_scan_first(self):
        proc, calls = self.run_bridge(make_report(scan_id=None))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("insert_scan", [c["call"] for c in calls])
        scan = next(c for c in calls if c["call"] == "insert_scan")
        # The teammate's _normalise_violations requires these exact keys.
        for key in ("rule_id", "selector", "severity", "description", "source_file"):
            self.assertIn(key, scan["violations"][0], f"violation_for_scans must carry {key}")

    def test_existing_scan_id_is_reused_not_duplicated(self):
        proc, calls = self.run_bridge(make_report(scan_id="65f000000000000000000001"))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn("insert_scan", [c["call"] for c in calls],
                         "a report carrying a Mongo scan id must not create a second scans document")

    def test_help_exits_zero(self):
        proc = subprocess.run([sys.executable, str(BRIDGE), "--help"], capture_output=True, text=True, timeout=30)
        self.assertEqual(proc.returncode, 0)
        self.assertIn("Record a finished fix", proc.stdout)

    # ── EDGE ────────────────────────────────────────────────────────────────
    def test_unfixed_report_records_nothing_by_default(self):
        proc, calls = self.run_bridge(make_report(status="failed"))
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(calls, [])

    def test_record_failures_flag_logs_the_failure(self):
        proc, calls = self.run_bridge(make_report(status="failed"), extra=["--record-failures"])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        events = [c for c in calls if c["call"] == "insert_audit_event"]
        self.assertEqual([e["event_type"] for e in events], ["patch_applied"],
                         "a failed fix logs patch_applied but must NOT log 'verified'")

    def test_report_without_mongo_patch_exits_1(self):
        proc, calls = self.run_bridge({"status": "fixed"})
        self.assertEqual(proc.returncode, 1)
        self.assertIn("no mongo_patch", proc.stderr)

    def test_mongodb_unavailable_exits_2_and_writes_nothing(self):
        proc, calls = self.run_bridge(make_report(), mode="down")
        self.assertEqual(proc.returncode, 2, f"stdout={proc.stdout} stderr={proc.stderr}")
        self.assertNotIn("insert_patch", [c["call"] for c in calls])
        self.assertIn("close", [c["call"] for c in calls], "the client must still be closed")

    # ── HARD / adversarial ──────────────────────────────────────────────────
    def test_nonexistent_report_file_exits_cleanly_not_with_a_traceback(self):
        proc = subprocess.run(
            [sys.executable, str(BRIDGE), str(self.root / "nope.json"), "--repo-root", str(self.root)],
            capture_output=True, text=True, timeout=30,
            env={**os.environ, "STUB_LOG": str(self.log)},
        )
        self.assertNotIn("Traceback", proc.stderr,
                         "a missing report file must produce a readable error, not a Python traceback")
        self.assertEqual(proc.returncode, 1)

    def test_malformed_report_json_exits_cleanly(self):
        proc, _ = self.run_bridge("{not valid json")
        self.assertNotIn("Traceback", proc.stderr,
                         "a corrupt report.json must produce a readable error, not a traceback")
        self.assertEqual(proc.returncode, 1)

    def test_repo_root_flag_with_no_value_does_not_crash(self):
        p = self.root / "r.json"
        p.write_text(json.dumps(make_report()))
        proc = subprocess.run(
            [sys.executable, str(BRIDGE), str(p), "--repo-root"],
            capture_output=True, text=True, timeout=30,
            env={**os.environ, "STUB_LOG": str(self.log)},
        )
        self.assertNotIn("IndexError", proc.stderr,
                         "--repo-root as the final argument must be reported, not raise IndexError")

    def test_first_argument_that_is_a_flag_is_rejected(self):
        proc = subprocess.run(
            [sys.executable, str(BRIDGE), "--dry-run", "--repo-root", str(self.root)],
            capture_output=True, text=True, timeout=30,
            env={**os.environ, "STUB_LOG": str(self.log)},
        )
        self.assertNotIn("Traceback", proc.stderr,
                         "a missing report path (first arg is a flag) must be reported clearly")
        self.assertNotEqual(proc.returncode, 0)

    def test_audit_event_types_match_the_stores_allow_list(self):
        """insert_audit_event raises ValueError for an unknown event_type."""
        src = REAL_STORE.read_text()
        self.assertIn('AUDIT_EVENT_TYPES = frozenset({"scan_run", "patch_applied", "verified"})', src)
        bridge_src = BRIDGE.read_text()
        for ev in ("patch_applied", "verified"):
            self.assertIn(f'"{ev}"', bridge_src)

    def test_insert_patch_kwargs_match_the_real_store_signature(self):
        """The bridge calls insert_patch(...) by keyword; the real signature must accept each one."""
        import inspect, importlib.util
        spec = importlib.util.spec_from_file_location("real_mongo_store", REAL_STORE)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        sig = inspect.signature(mod.MongoStore.insert_patch)
        used = {"scan_id", "violation_rule_id", "source_file", "original_snippet",
                "patched_snippet", "model_used", "verified"}
        self.assertTrue(used <= set(sig.parameters), f"bridge passes {used - set(sig.parameters)} which insert_patch does not accept")

    def test_a_non_objectid_scan_id_is_reported_not_a_raw_traceback(self):
        """fix.mjs copies mongo_scan_id through verbatim; a non-ObjectId string reaches _as_object_id.

        The real store validates with a plain ValueError, which is NOT a PyMongoError — so the
        bridge must catch that class of error too, and report it as bad input (exit 1).
        """
        import importlib.util
        from pymongo.errors import PyMongoError
        spec = importlib.util.spec_from_file_location("real_mongo_store", REAL_STORE)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        with self.assertRaises(ValueError):
            mod._as_object_id("not-an-objectid", "scan_id")
        self.assertFalse(issubclass(ValueError, PyMongoError),
                         "precondition: the store's validation error is not a PyMongoError")

        # The bridge must survive it: stub insert_patch raises the same ValueError the real
        # _as_object_id would, and the bridge must exit 1 with a readable message.
        proc, _ = self.run_bridge(make_report(scan_id="not-an-objectid"), mode="objectid_raises")
        self.assertNotIn("Traceback", proc.stderr,
                         "an invalid scan_id must be reported clearly, not as an uncaught ValueError")
        self.assertEqual(proc.returncode, 1, f"stdout={proc.stdout} stderr={proc.stderr}")
        self.assertIn("cannot record", proc.stderr)

    def test_record_failures_writes_no_patches_document(self):
        """A failed fix was rolled back, so there is no patch: an audit event only."""
        proc, calls = self.run_bridge(make_report(status="failed"), extra=["--record-failures"])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn("insert_patch", [c["call"] for c in calls],
                         "a rolled-back fix must not be stored as a patches document with empty snippets")
        self.assertIn("insert_audit_event", [c["call"] for c in calls])

    def test_a_bad_mongodb_uri_exits_2_not_a_traceback(self):
        """MongoClient resolves the URI during construction; that must still be the documented exit 2."""
        proc, _ = self.run_bridge(make_report(), mode="ctor_raises")
        self.assertNotIn("Traceback", proc.stderr)
        self.assertEqual(proc.returncode, 2, f"stdout={proc.stdout} stderr={proc.stderr}")

    def test_flag_before_the_positional_is_accepted(self):
        """`--record-failures out/x/report.json` is an ordering argparse would accept."""
        p = self.root / "r.json"
        p.write_text(json.dumps(make_report()))
        env = {**os.environ, "STUB_LOG": str(self.log), "STUB_MODE": "ok"}
        proc = subprocess.run(
            [sys.executable, str(BRIDGE), "--record-failures", str(p), "--repo-root", str(self.root)],
            capture_output=True, text=True, env=env, timeout=60,
        )
        self.assertNotIn("Traceback", proc.stderr)
        self.assertEqual(proc.returncode, 0, f"stdout={proc.stdout} stderr={proc.stderr}")

    def test_an_unknown_option_is_rejected(self):
        proc, _ = self.run_bridge(make_report(), extra=["--not-a-flag"])
        self.assertEqual(proc.returncode, 1)
        self.assertIn("unknown option", proc.stderr)

    def test_docstring_scan_id_path_matches_the_code(self):
        """The module docstring documents where scan_id comes from; it must be accurate."""
        src = BRIDGE.read_text()
        doc = src.split('"""')[1]
        self.assertNotIn("report.mongo_scan_id", doc,
                         "the docstring says scan_id comes from report.mongo_scan_id, but the code reads "
                         "report['mongo_patch']['scan_id']")


if __name__ == "__main__":
    unittest.main(verbosity=2)
