#!/usr/bin/env python3
"""Build the trilingual (English / Malay / Chinese) SayCheck suite + audio.

Audio is synthesised with the macOS `say` command so the example ships
reproducibly without a GPU or an API key. Swap `--engine chatterbox` later
if you want one cloned voice across all three languages.

Usage:
    python3 scripts/build_tri_suite.py            # regenerate audio + suite
    python3 scripts/build_tri_suite.py --no-audio # only rewrite the JSON
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_AUDIO = ROOT / "examples" / "audio-tri"
OUT_SUITE = ROOT / "examples" / "saycheck-tri-36.suite.json"

SAMPLE_RATE = 48000

# voice: macOS `say -v` name, checked against `say -v '?'`
LANGS = [
    ("en", "英语 · English", "en-US", "Samantha"),
    ("ms", "马来语 · Bahasa Melayu", "ms-MY", "Amira"),
    ("zh", "中文 · Chinese", "zh-CN", "Tingting"),
]

# One row per intent, so the three languages are directly comparable.
# (intent id, scene, english, malay, chinese)
INTENTS = [
    ("greet", "唤醒后打招呼", "Hello there, can you hear me", "Helo, boleh dengar saya", "你好呀，能听到我说话吗"),
    ("start", "请机器人开始导览", "Please start the tour", "Sila mulakan lawatan", "请开始导览"),
    ("company", "询问公司情况", "Tell me about the company", "Ceritakan tentang syarikat ini", "介绍一下公司"),
    ("dept", "询问机器人部门", "What does the robot team do", "Apa tugas pasukan robot", "机器人部门做什么"),
    ("case", "询问落地案例", "Show me a factory case", "Tunjukkan contoh di kilang", "讲一个工厂案例"),
    ("handshake", "主动请求握手", "Let us shake hands", "Mari berjabat tangan", "我们握个手"),
    ("wave", "请求挥手", "Wave your hand please", "Lambai tangan anda", "挥挥手"),
    ("bow", "请求鞠躬", "Please bow to us", "Tunduk hormat sedikit", "鞠个躬"),
    ("thanks", "道谢", "Thank you very much", "Terima kasih banyak", "非常感谢"),
    ("guide", "请求带路", "Take me to the meeting room", "Bawa saya ke bilik mesyuarat", "带我去会议室"),
    ("bye", "告别", "Goodbye, see you next time", "Selamat tinggal, jumpa lagi", "再见，下次见"),
    ("cheer", "鼓励机器人", "Keep up the good work", "Teruskan usaha yang baik", "加油，做得好"),
]

DEFAULTS = {
    "rounds": 5,
    "gapMs": 1500,
    "windowMs": 5000,
    "settleMs": 900,
    "silenceMs": 1000,
    "rmsPeakDb": -34,
    "frameDiff": 3,
    "rule": "any",
    "recordFailedOnly": True,
}


def synth(voice: str, text: str, out: Path) -> None:
    """macOS `say` → 48 kHz mono 16-bit wav, matching the other examples."""
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "say",
            "-v", voice,
            f"--data-format=LEI16@{SAMPLE_RATE}",
            "-o", str(out),
            "--", text,
        ],
        check=True,
    )
    with wave.open(str(out)) as w:
        if w.getnchannels() != 1 or w.getframerate() != SAMPLE_RATE:
            raise SystemExit(f"{out.name}: unexpected format {w.getnchannels()}ch @ {w.getframerate()}")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-audio", action="store_true", help="skip synthesis, reuse existing wavs")
    args = ap.parse_args()

    groups = [{"id": f"g_{code}", "name": label, "scene": f"{label} 的同一批意图"} for code, label, _, _ in LANGS]

    utterances = []
    for code, label, locale, voice in LANGS:
        for i, row in enumerate(INTENTS, start=1):
            intent, scene, *texts = row
            text = texts[["en", "ms", "zh"].index(code)]
            uid = f"{code}-{i:02d}"
            wav = OUT_AUDIO / f"{uid}.wav"
            if not args.no_audio:
                synth(voice, text, wav)
            if not wav.exists():
                raise SystemExit(f"missing audio {wav} — run without --no-audio")
            utterances.append(
                {
                    "id": uid,
                    "groupId": f"g_{code}",
                    "text": text,
                    "translation": f"{intent} · {scene}",
                    "tags": [f"lang:{code}", f"intent:{intent}", f"chars:{len(text)}"],
                    "audio": {
                        "path": f"audio-tri/{uid}.wav",
                        "provider": "macos-say",
                        "model": voice,
                        "languageId": locale,
                        "sha256": sha256(wav),
                    },
                }
            )

    suite = {
        "schemaVersion": "1.0",
        "id": "saycheck-tri-36",
        "title": "Trilingual voice commands — English / Malay / Chinese (36 utterances)",
        "description": (
            "The same 12 intents spoken in English, Malay and Chinese, so recognition "
            "rates can be compared across languages on one robot. Audio is synthesised "
            "with macOS `say` (Samantha / Amira / Tingting) and regenerated by "
            "scripts/build_tri_suite.py."
        ),
        "locale": "mul",
        "license": "CC-BY-4.0",
        "audioBase": "",
        "groups": groups,
        "defaults": DEFAULTS,
        "utterances": utterances,
    }
    OUT_SUITE.write_text(json.dumps(suite, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT_SUITE.relative_to(ROOT)} — {len(utterances)} utterances, {len(groups)} groups")
    return 0


if __name__ == "__main__":
    sys.exit(main())
