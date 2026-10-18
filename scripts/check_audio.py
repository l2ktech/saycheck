#!/usr/bin/env python3
"""Verify that a suite's audio files exist and match their recorded checksums.

Run this in CI and before publishing. A suite whose audio has been regenerated
but whose `sha256` was not updated is worse than useless: the pass rates in your
notes no longer describe the audio the robot actually heard.

Usage:
    python3 scripts/check_audio.py examples/saycheck-ja-45.suite.json
    python3 scripts/check_audio.py examples/*.suite.json --quiet
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def check(path: Path, quiet: bool) -> int:
    doc = json.loads(path.read_text(encoding="utf-8"))
    base = path.parent / (doc.get("audioBase") or "")
    missing: list[str] = []
    mismatched: list[str] = []
    checked = 0

    for utt in doc.get("utterances", []):
        audio = utt.get("audio")
        if not audio:
            continue
        target = base / audio["path"]
        checked += 1
        if not target.exists():
            missing.append(f"{utt['id']}: {target}")
            continue
        expected = audio.get("sha256")
        if expected and sha256_of(target) != expected:
            mismatched.append(f"{utt['id']}: {target}")

    label = path.name
    if missing or mismatched:
        print(f"FAIL {label} — {len(missing)} missing, {len(mismatched)} checksum mismatch")
        for line in missing:
            print(f"  missing   {line}")
        for line in mismatched:
            print(f"  checksum  {line}")
        return 1

    if not quiet:
        print(f"OK   {label} — {checked} audio file(s) present and matching")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("suites", nargs="+", type=Path)
    ap.add_argument("--quiet", action="store_true", help="only print failures")
    args = ap.parse_args(argv)

    failures = 0
    for suite in args.suites:
        if not suite.exists():
            print(f"FAIL {suite} — file not found")
            failures += 1
            continue
        failures += check(suite, args.quiet)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
