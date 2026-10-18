#!/usr/bin/env python3
"""Minimal command-provider that emits silence.

Useful for wiring up the proxy before a real engine is ready: it proves the
plumbing end to end in about a second, and it is the shape your own provider
should follow.

Contract:
    stdin   {"text": "...", "voice": "default", "language": "ja", "speed": 1.0}
    stdout  audio bytes (WAV is detected by its RIFF header, MP3 by its frame)
    stderr  anything you want logged
"""
import io
import json
import sys
import wave

DEFAULT_SR = 48000
SECONDS_PER_CHAR = 0.055
MIN_SECONDS = 0.4
MAX_SECONDS = 6.0


def main() -> int:
    raw = sys.stdin.buffer.read() or b"{}"
    try:
        req = json.loads(raw)
    except json.JSONDecodeError as exc:
        print(f"bad json: {exc}", file=sys.stderr)
        return 2

    text = (req.get("text") or "").strip()
    if not text:
        print("empty text", file=sys.stderr)
        return 2

    duration = min(MAX_SECONDS, max(MIN_SECONDS, len(text) * SECONDS_PER_CHAR))
    frames = int(DEFAULT_SR * duration)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(DEFAULT_SR)
        w.writeframes(b"\x00\x00" * frames)

    sys.stdout.buffer.write(buf.getvalue())
    print(f"silence: {duration:.2f}s for {len(text)} chars", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
