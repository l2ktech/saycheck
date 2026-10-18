#!/usr/bin/env python3
"""Turn an internal candidate list into a publishable SayCheck suite.

Two jobs:
  1. Apply a replacement map so no customer names or project details ship.
  2. Annotate each utterance with linguistic features (mora count, keigo,
     loanwords, numbers). Those tags are what make failure attribution
     possible later: "all failures were 13+ mora" is only answerable if the
     tags were recorded up front.

The replacement map is intentionally NOT hard-coded here and is expected to
live outside the repository. Run without --map and the text passes through
untouched, which is fine for content that was never confidential.

Usage:
    python3 scripts/anonymize_suite.py \
        --candidates ../outputs/trigger-test/candidates-doc.json \
        --platform   ../outputs/trigger-test/platform-triggers.json \
        --map        /tmp/saycheck.map.json \
        --audio-src  ../outputs/local-tts \
        --out        examples/saycheck-ja-45.suite.json \
        --suite-id   saycheck-ja-basic \
        --title      "Japanese voice commands for a service robot (45 utterances)"

Map file format:
{
  "replacements": [
    {"from": "ACME", "to": "our company", "fields": ["text", "translation"]}
  ],
  "groups": {
    "<source-group-id>": {"name": "Greeting", "scene": "Opening / ask the robot to start"}
  },
  "dropUtteranceIds": []
}
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import unicodedata
from pathlib import Path

# ---------------------------------------------------------------- linguistics

SMALL_KANA = set("ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ")
KANA_RE = re.compile(r"[\u3041-\u309F\u30A1-\u30FF]")
KANJI_RE = re.compile(r"[\u4E00-\u9FFF]")
KATAKANA_RE = re.compile(r"[\u30A1-\u30FA]")
NUMBER_RE = re.compile(r"[0-9０-９一二三四五六七八九十百千万億]")
KEIGO_RE = re.compile(r"です|ます|ください|ございます|お願い|いただけ|伺|存じ")
QUESTION_RE = re.compile(r"か[。？?]?$|？|\?")


def mora_count(text: str) -> int:
    """Approximate Japanese mora count.

    Kana are counted one each (small kana and the long-vowel mark are not
    separate morae). Kanji have unknown readings here, so they are estimated
    at two morae, which is the common average for two-kanji compounds. Good
    enough to bucket utterances as short/medium/long; not a phonemizer.
    """
    n = 0
    for ch in text:
        if ch in SMALL_KANA or ch == "ー":
            continue
        if KANA_RE.match(ch):
            n += 1
        elif KANJI_RE.match(ch):
            n += 2
        elif ch.isdigit():
            n += 2
    return n


def features(text: str) -> list[str]:
    """Linguistic tags used for failure attribution."""
    tags: list[str] = []

    mora = mora_count(text)
    # Buckets chosen against real data: Japanese service-robot requests cluster
    # at 12-20 mora, so a 6/12 split put three quarters of them in "long" and
    # told you nothing. 10/16 splits the same corpus roughly evenly.
    if mora <= 10:
        tags.append("mora:short")
    elif mora <= 16:
        tags.append("mora:mid")
    else:
        tags.append("mora:long")

    if KANJI_RE.search(text):
        tags.append("kanji")
    kata = len(KATAKANA_RE.findall(text))
    if kata >= 2:
        tags.append("loanword")
    if KEIGO_RE.search(text):
        tags.append("keigo")
    if QUESTION_RE.search(text):
        tags.append("question")
    if NUMBER_RE.search(text):
        tags.append("number")
    if "お願い" in text or "ください" in text:
        tags.append("request")
    return tags


# ------------------------------------------------------------------ anonymize


def apply_replacements(value: str, replacements: list[dict], field: str) -> str:
    out = value
    for rule in replacements:
        fields = rule.get("fields")
        if fields and field not in fields:
            continue
        src = rule.get("from")
        if not src:
            continue
        out = out.replace(src, rule.get("to", ""))
    return out


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def normalize_text(s: str) -> str:
    return unicodedata.normalize("NFC", s).strip()


# ----------------------------------------------------------------------- main


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--candidates", required=True, type=Path, help="candidates-doc.json")
    ap.add_argument("--platform", type=Path, help="platform-triggers.json; when given, only utterances present there are exported")
    ap.add_argument("--map", dest="map_file", type=Path, help="replacement map (keep outside the repo)")
    ap.add_argument("--audio-src", type=Path, help="directory containing table<id>/t<id>-<nn>.wav")
    ap.add_argument("--audio-out", type=Path, help="where to copy audio; defaults to <out>/../audio")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--suite-id", default="saycheck-ja-basic")
    ap.add_argument("--title", default="Japanese voice commands (anonymized)")
    ap.add_argument("--locale", default="ja-JP")
    ap.add_argument("--group-order", default="", help="comma separated source group ids, e.g. 25341,25338")
    args = ap.parse_args(argv)

    cand = json.loads(args.candidates.read_text(encoding="utf-8"))
    plat = {}
    if args.platform:
        plat_doc = json.loads(args.platform.read_text(encoding="utf-8"))
        plat = plat_doc.get("platform") or {}

    mapping = {}
    if args.map_file:
        mapping = json.loads(args.map_file.read_text(encoding="utf-8"))
    replacements = mapping.get("replacements", [])
    group_meta = mapping.get("groups", {})

    if not replacements:
        print("warning: no --map given; text is exported verbatim", file=sys.stderr)

    keys = [k for k in cand.keys() if not k.startswith("_")]
    if args.group_order:
        order = [s.strip() for s in args.group_order.split(",") if s.strip()]
        keys = [k for k in order if k in cand]
    else:
        keys = [k for k in keys if not args.platform or k in plat]

    groups = []
    utterances = []
    audio_dir = args.audio_out or (args.out.parent / "audio")
    copied = 0

    for gi, src_gid in enumerate(keys, 1):
        gid = f"g{gi}"
        meta = group_meta.get(src_gid) or {}
        allowed = set(plat.get(src_gid) or []) if args.platform else None

        rows = cand[src_gid]
        picked = []
        for idx, row in enumerate(rows, 1):
            ja = row["ja"] if isinstance(row, dict) else row
            zh = row.get("zh", "") if isinstance(row, dict) else ""
            ja = normalize_text(ja)
            if allowed is not None and ja not in allowed:
                continue
            picked.append((idx, ja, zh))

        if not picked:
            continue

        groups.append({
            "id": gid,
            "name": meta.get("name") or f"Group {gi}",
            **({"scene": meta["scene"]} if meta.get("scene") else {}),
        })

        for n, (src_idx, ja, zh) in enumerate(picked, 1):
            uid = f"{gid}-{n:02d}"
            text = apply_replacements(ja, replacements, "text")
            translation = apply_replacements(zh, replacements, "translation")

            utt: dict = {
                "id": uid,
                "groupId": gid,
                "text": text,
            }
            if translation:
                utt["translation"] = translation

            tags = features(text)
            if tags:
                utt["tags"] = tags

            if args.audio_src:
                src = args.audio_src / f"table{src_gid}" / f"t{src_gid}-{src_idx:02d}.wav"
                if src.exists():
                    audio_dir.mkdir(parents=True, exist_ok=True)
                    dst = audio_dir / f"{uid}.wav"
                    if not dst.exists() or dst.stat().st_size != src.stat().st_size:
                        shutil.copy2(src, dst)
                        copied += 1
                    utt["audio"] = {
                        "path": f"audio/{uid}.wav",
                        "provider": "irodori",
                        "model": "v4.1-small-mf-8bit",
                        "languageId": args.locale,
                        "sha256": sha256_of(dst),
                    }

            utterances.append(utt)

    suite = {
        "schemaVersion": "1.0",
        "id": args.suite_id,
        "title": args.title,
        "description": (
            "Voice commands used to test wake-word and intent recognition on a service robot. "
            "Text is anonymized; linguistic features (mora count, keigo, loanwords) are preserved "
            "so results remain comparable."
        ),
        "locale": args.locale,
        "license": "CC-BY-4.0",
        "audioBase": "",
        "groups": groups,
        "defaults": {
            "rounds": 5,
            "gapMs": 1500,
            "windowMs": 5000,
            "settleMs": 900,
            "silenceMs": 1000,
            "rmsPeakDb": -34,
            "frameDiff": 3,
            "rule": "any",
            "recordFailedOnly": True,
        },
        "utterances": utterances,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(suite, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    by_group = {g["id"]: 0 for g in groups}
    for u in utterances:
        by_group[u["groupId"]] += 1
    print(f"wrote {args.out}  ({len(utterances)} utterances in {len(groups)} groups)")
    for g in groups:
        print(f"  {g['id']}  {by_group[g['id']]:>3}  {g['name']}")
    if args.audio_src:
        print(f"audio: {copied} copied, {len(utterances) - copied} already present or missing at source")
    return 0


if __name__ == "__main__":
    sys.exit(main())
