#!/usr/bin/env python3
"""Validate a SayCheck suite or session file. Zero third-party dependencies.

Usage:
    python3 scripts/validate.py suite   examples/saycheck-ja-45.suite.json
    python3 scripts/validate.py session examples/sample.session.json
    python3 scripts/validate.py auto    some-file.json     # guess from content

Exit code 0 = valid, 1 = invalid, 2 = usage error.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,63}$")
UID_RE = re.compile(r"^[a-zA-Z0-9._-]{1,60}$")
LOCALE_RE = re.compile(r"^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$")
SHA_RE = re.compile(r"^[a-f0-9]{64}$")
VERDICTS = {"pass", "fail", "inconclusive", "skip"}
RATING_KEYS = {"trials", "pass", "fail", "inconclusive", "passRate", "medianLatencyMs"}


class Errors(list):
    def add(self, path: str, msg: str) -> None:
        self.append(f"{path}: {msg}")

    def report(self, label: str) -> int:
        if not self:
            print(f"OK  {label}")
            return 0
        print(f"FAIL {label} — {len(self)} problem(s)")
        for e in self:
            print(f"  - {e}")
        return 1


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def check_suite(doc: dict, errs: Errors) -> None:
    required = ["schemaVersion", "id", "title", "locale", "utterances"]
    for k in required:
        if k not in doc:
            errs.add(k, "required field missing")

    if doc.get("schemaVersion") != "1.0":
        errs.add("schemaVersion", f"expected '1.0', got {doc.get('schemaVersion')!r}")

    sid = doc.get("id")
    if not isinstance(sid, str) or not ID_RE.match(sid or ""):
        errs.add("id", f"must match {ID_RE.pattern}, got {sid!r}")

    if not isinstance(doc.get("title"), str) or not doc.get("title"):
        errs.add("title", "must be a non-empty string")

    if not isinstance(doc.get("locale"), str) or not LOCALE_RE.match(doc.get("locale") or ""):
        errs.add("locale", f"must be a BCP-47 tag like ja-JP, got {doc.get('locale')!r}")

    for key in ("description", "audioBase", "license"):
        if key in doc and not isinstance(doc[key], str):
            errs.add(key, "must be a string")

    robot = doc.get("robot")
    if robot is not None:
        if not isinstance(robot, dict):
            errs.add("robot", "must be an object")
        else:
            allowed = {"vendor", "model", "firmware", "note"}
            for k in robot:
                if k not in allowed:
                    errs.add(f"robot.{k}", "unknown field")

    groups = doc.get("groups", [])
    if not isinstance(groups, list):
        errs.add("groups", "must be an array")
        groups = []
    gids = set()
    for i, g in enumerate(groups):
        p = f"groups[{i}]"
        if not isinstance(g, dict):
            errs.add(p, "must be an object")
            continue
        for k in ("id", "name"):
            if not isinstance(g.get(k), str) or not g.get(k):
                errs.add(f"{p}.{k}", "required non-empty string")
        gid = g.get("id")
        if isinstance(gid, str):
            if gid in gids:
                errs.add(f"{p}.id", f"duplicate group id {gid!r}")
            gids.add(gid)

    defaults = doc.get("defaults")
    if defaults is not None:
        if not isinstance(defaults, dict):
            errs.add("defaults", "must be an object")
        else:
            bounds = {
                "rounds": (1, 50),
                "gapMs": (200, 30000),
                "windowMs": (500, 30000),
            }
            for k, (lo, hi) in bounds.items():
                if k in defaults:
                    v = defaults[k]
                    if not _is_int(v) or not lo <= v <= hi:
                        errs.add(f"defaults.{k}", f"must be an integer in [{lo}, {hi}]")
            for k in ("rmsPeakDb", "frameDiff"):
                if k in defaults and not _is_num(defaults[k]):
                    errs.add(f"defaults.{k}", "must be a number")
            if "recordFailedOnly" in defaults and not isinstance(defaults["recordFailedOnly"], bool):
                errs.add("defaults.recordFailedOnly", "must be a boolean")

    utts = doc.get("utterances")
    if not isinstance(utts, list) or not utts:
        errs.add("utterances", "must be a non-empty array")
        return

    seen = set()
    for i, u in enumerate(utts):
        p = f"utterances[{i}]"
        if not isinstance(u, dict):
            errs.add(p, "must be an object")
            continue
        uid = u.get("id")
        if not isinstance(uid, str) or not UID_RE.match(uid or ""):
            errs.add(f"{p}.id", f"must match {UID_RE.pattern}, got {uid!r}")
        elif uid in seen:
            errs.add(f"{p}.id", f"duplicate utterance id {uid!r}")
        else:
            seen.add(uid)

        text = u.get("text")
        if not isinstance(text, str) or not text.strip():
            errs.add(f"{p}.text", "must be a non-empty string")
        elif len(text) > 500:
            errs.add(f"{p}.text", "longer than 500 characters")

        gid = u.get("groupId")
        if gid is not None and gid not in gids:
            errs.add(f"{p}.groupId", f"{gid!r} does not match any groups[].id")

        audio = u.get("audio")
        if audio is not None:
            if not isinstance(audio, dict):
                errs.add(f"{p}.audio", "must be an object")
            else:
                if not isinstance(audio.get("path"), str) or not audio.get("path"):
                    errs.add(f"{p}.audio.path", "required non-empty string")
                if "durationMs" in audio and (not _is_int(audio["durationMs"]) or audio["durationMs"] < 1):
                    errs.add(f"{p}.audio.durationMs", "must be a positive integer")
                if "sha256" in audio and not SHA_RE.match(str(audio["sha256"])):
                    errs.add(f"{p}.audio.sha256", "must be 64 lowercase hex characters")

        expect = u.get("expect")
        if expect is not None:
            if not isinstance(expect, dict):
                errs.add(f"{p}.expect", "must be an object")
            else:
                for k in expect:
                    if k not in {"action", "reply", "maxLatencyMs"}:
                        errs.add(f"{p}.expect.{k}", "unknown field")

        tags = u.get("tags")
        if tags is not None:
            if not isinstance(tags, list) or any(not isinstance(t, str) for t in tags):
                errs.add(f"{p}.tags", "must be an array of strings")
            elif len(tags) > 20:
                errs.add(f"{p}.tags", "more than 20 tags")

    # Cross-check: every declared group should have at least one utterance.
    used = {u.get("groupId") for u in utts if isinstance(u, dict) and u.get("groupId")}
    for gid in gids - used:
        errs.add("groups", f"group {gid!r} has no utterances")


def check_session(doc: dict, errs: Errors) -> None:
    for k in ("schemaVersion", "suiteId", "sessionId", "trials"):
        if k not in doc:
            errs.add(k, "required field missing")

    if doc.get("schemaVersion") != "1.0":
        errs.add("schemaVersion", f"expected '1.0', got {doc.get('schemaVersion')!r}")

    for k in ("suiteId", "sessionId", "startedAt", "endedAt", "operator"):
        if k in doc and not isinstance(doc[k], str):
            errs.add(k, "must be a string")

    if "suiteHash" in doc and not SHA_RE.match(str(doc["suiteHash"])):
        errs.add("suiteHash", "must be 64 lowercase hex characters")

    for k in ("device", "thresholds", "environment", "summary"):
        if k in doc and not isinstance(doc[k], dict):
            errs.add(k, "must be an object")

    th = doc.get("thresholds") or {}
    for k in ("rmsBaselineDb", "rmsPeakDb", "frameDiff", "windowMs"):
        if k in th:
            v = th[k]
            if k == "windowMs" and not _is_int(v):
                errs.add(f"thresholds.{k}", "must be an integer")
            elif k != "windowMs" and not _is_num(v):
                errs.add(f"thresholds.{k}", "must be a number")

    trials = doc.get("trials")
    if not isinstance(trials, list) or not trials:
        errs.add("trials", "must be a non-empty array")
        return

    seen_pairs = set()
    for i, t in enumerate(trials):
        p = f"trials[{i}]"
        if not isinstance(t, dict):
            errs.add(p, "must be an object")
            continue
        uid = t.get("utteranceId")
        if not isinstance(uid, str) or not uid:
            errs.add(f"{p}.utteranceId", "required non-empty string")
        rnd = t.get("round")
        if not _is_int(rnd) or rnd < 1:
            errs.add(f"{p}.round", "must be an integer >= 1")
        pair = (uid, rnd)
        if pair in seen_pairs:
            errs.add(p, f"duplicate trial for utteranceId={uid!r} round={rnd}")
        seen_pairs.add(pair)

        sv = t.get("sensorVerdict")
        if sv not in VERDICTS:
            errs.add(f"{p}.sensorVerdict", f"must be one of {sorted(VERDICTS)}")
        hv = t.get("humanVerdict")
        if hv is not None and hv not in VERDICTS:
            errs.add(f"{p}.humanVerdict", f"must be one of {sorted(VERDICTS)} or null")

        metrics = t.get("metrics")
        if metrics is not None:
            if not isinstance(metrics, dict):
                errs.add(f"{p}.metrics", "must be an object")
            else:
                for k in metrics:
                    if k not in {"peakRmsDb", "baselineRmsDb", "frameDiff", "latencyMs"}:
                        errs.add(f"{p}.metrics.{k}", "unknown field")
                if "latencyMs" in metrics and (not _is_int(metrics["latencyMs"]) or metrics["latencyMs"] < 0):
                    errs.add(f"{p}.metrics.latencyMs", "must be a non-negative integer")

        agr = t.get("agreement")
        if agr is not None and not isinstance(agr, bool):
            errs.add(f"{p}.agreement", "must be a boolean")

    # Recompute agreement where both verdicts exist, to catch hand-edited files.
    for i, t in enumerate(trials):
        if not isinstance(t, dict):
            continue
        sv, hv, agr = t.get("sensorVerdict"), t.get("humanVerdict"), t.get("agreement")
        if hv in ("pass", "fail") and sv in ("pass", "fail") and isinstance(agr, bool):
            if agr != (sv == hv):
                errs.add(f"trials[{i}].agreement", "does not match sensorVerdict vs humanVerdict")


def guess_kind(doc: dict) -> str:
    if "utterances" in doc:
        return "suite"
    if "trials" in doc:
        return "session"
    return "unknown"


def main(argv: list[str]) -> int:
    if len(argv) < 3 or argv[1] not in {"suite", "session", "auto"}:
        print(__doc__)
        return 2

    kind, path = argv[1], Path(argv[2])
    if not path.exists():
        print(f"file not found: {path}")
        return 2

    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"FAIL {path.name} — not valid JSON: {exc}")
        return 1

    if not isinstance(doc, dict):
        print(f"FAIL {path.name} — top-level value must be an object")
        return 1

    if kind == "auto":
        kind = guess_kind(doc)
        if kind == "unknown":
            print(f"FAIL {path.name} — cannot tell suite from session (no 'utterances' or 'trials')")
            return 1

    errs = Errors()
    (check_suite if kind == "suite" else check_session)(doc, errs)
    return errs.report(f"{path.name} ({kind})")


if __name__ == "__main__":
    sys.exit(main(sys.argv))
