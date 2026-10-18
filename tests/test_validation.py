#!/usr/bin/env python3
"""Tests for the command-line validators.

These exercise the real CLI (subprocess), because that is what CI and users run.
The interesting cases are all failures: a validator that only ever prints OK is
indistinguishable from `cat`.

Run: python3 -m unittest discover -s tests -v
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VALIDATE = ROOT / "scripts" / "validate.py"
CHECK_AUDIO = ROOT / "scripts" / "check_audio.py"


def run(script: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(script), *args],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )


def minimal_suite() -> dict:
    return {
        "schemaVersion": "1.0",
        "id": "test-suite",
        "title": "Test",
        "locale": "ja-JP",
        "groups": [{"id": "g1", "name": "Greeting"}],
        "utterances": [
            {"id": "g1-01", "groupId": "g1", "text": "こんにちは"},
        ],
    }


class ValidateSuite(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, doc: dict, name: str = "suite.json") -> Path:
        p = self.dir / name
        p.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
        return p

    def test_accepts_minimal_suite(self):
        p = self.write(minimal_suite())
        r = run(VALIDATE, "suite", str(p))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("OK", r.stdout)

    def test_rejects_missing_schema_version(self):
        doc = minimal_suite()
        del doc["schemaVersion"]
        r = run(VALIDATE, "suite", str(self.write(doc)))
        self.assertEqual(r.returncode, 1)
        self.assertIn("schemaVersion", r.stdout)

    def test_rejects_duplicate_utterance_id(self):
        doc = minimal_suite()
        doc["utterances"].append({"id": "g1-01", "groupId": "g1", "text": "again"})
        r = run(VALIDATE, "suite", str(self.write(doc)))
        self.assertEqual(r.returncode, 1)
        self.assertIn("duplicate utterance id", r.stdout)

    def test_rejects_dangling_group_reference(self):
        doc = minimal_suite()
        doc["utterances"][0]["groupId"] = "nope"
        r = run(VALIDATE, "suite", str(self.write(doc)))
        self.assertEqual(r.returncode, 1)
        self.assertIn("does not match any groups", r.stdout)

    def test_rejects_group_with_no_utterances(self):
        doc = minimal_suite()
        doc["groups"].append({"id": "g2", "name": "Unused"})
        r = run(VALIDATE, "suite", str(self.write(doc)))
        self.assertEqual(r.returncode, 1)
        self.assertIn("has no utterances", r.stdout)

    def test_rejects_bad_sha256(self):
        doc = minimal_suite()
        doc["utterances"][0]["audio"] = {"path": "a.wav", "sha256": "nothex"}
        r = run(VALIDATE, "suite", str(self.write(doc)))
        self.assertEqual(r.returncode, 1)
        self.assertIn("sha256", r.stdout)

    def test_rejects_non_json(self):
        p = self.dir / "bad.json"
        p.write_text("{not json", encoding="utf-8")
        r = run(VALIDATE, "suite", str(p))
        self.assertEqual(r.returncode, 1)
        self.assertIn("not valid JSON", r.stdout)

    def test_auto_detects_suite(self):
        p = self.write(minimal_suite())
        r = run(VALIDATE, "auto", str(p))
        self.assertEqual(r.returncode, 0)
        self.assertIn("(suite)", r.stdout)


class ValidateSession(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def session(self) -> dict:
        return {
            "schemaVersion": "1.0",
            "suiteId": "test-suite",
            "sessionId": "2026-10-18T10:00:00+08:00",
            "trials": [{
                "utteranceId": "g1-01",
                "round": 1,
                "sensorVerdict": "pass",
                "humanVerdict": "pass",
                "agreement": True,
            }],
        }

    def write(self, doc: dict) -> Path:
        p = self.dir / "session.json"
        p.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
        return p

    def test_accepts_minimal_session(self):
        r = run(VALIDATE, "session", str(self.write(self.session())))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_rejects_duplicate_round(self):
        doc = self.session()
        doc["trials"].append(dict(doc["trials"][0]))
        r = run(VALIDATE, "session", str(self.write(doc)))
        self.assertEqual(r.returncode, 1)
        self.assertIn("duplicate trial", r.stdout)

    def test_rejects_unknown_verdict(self):
        doc = self.session()
        doc["trials"][0]["sensorVerdict"] = "maybe"
        r = run(VALIDATE, "session", str(self.write(doc)))
        self.assertEqual(r.returncode, 1)
        self.assertIn("sensorVerdict", r.stdout)

    def test_rejects_agreement_that_contradicts_verdicts(self):
        doc = self.session()
        doc["trials"][0]["humanVerdict"] = "fail"
        doc["trials"][0]["agreement"] = True
        r = run(VALIDATE, "session", str(self.write(doc)))
        self.assertEqual(r.returncode, 1)
        self.assertIn("does not match", r.stdout)


class CheckAudio(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def build(self, payload: bytes, recorded: str | None = None) -> Path:
        (self.dir / "audio").mkdir(exist_ok=True)
        wav = self.dir / "audio" / "a.wav"
        wav.write_bytes(payload)

        import hashlib
        digest = recorded if recorded is not None else hashlib.sha256(payload).hexdigest()
        suite = {
            "schemaVersion": "1.0",
            "id": "t",
            "title": "t",
            "locale": "ja-JP",
            "utterances": [{
                "id": "u1",
                "text": "x",
                "audio": {"path": "audio/a.wav", "sha256": digest},
            }],
        }
        p = self.dir / "t.suite.json"
        p.write_text(json.dumps(suite, ensure_ascii=False), encoding="utf-8")
        return p

    def test_passes_when_hash_matches(self):
        r = run(CHECK_AUDIO, str(self.build(b"RIFFfake")))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("matching", r.stdout)

    def test_fails_on_checksum_mismatch(self):
        r = run(CHECK_AUDIO, str(self.build(b"new audio", recorded="0" * 64)))
        self.assertEqual(r.returncode, 1)
        self.assertIn("checksum", r.stdout)

    def test_fails_on_missing_file(self):
        p = self.build(b"x")
        (self.dir / "audio" / "a.wav").unlink()
        r = run(CHECK_AUDIO, str(p))
        self.assertEqual(r.returncode, 1)
        self.assertIn("missing", r.stdout)


class BundledExamples(unittest.TestCase):
    """The files we actually publish must pass the tools we ship."""

    def test_example_suite_validates(self):
        r = run(VALIDATE, "suite", "examples/saycheck-ja-45.suite.json")
        self.assertEqual(r.returncode, 0, r.stdout)

    def test_example_session_validates(self):
        r = run(VALIDATE, "session", "examples/sample.session.json")
        self.assertEqual(r.returncode, 0, r.stdout)

    def test_example_audio_matches_checksums(self):
        r = run(CHECK_AUDIO, "--quiet", "examples/saycheck-ja-45.suite.json")
        self.assertEqual(r.returncode, 0, r.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
