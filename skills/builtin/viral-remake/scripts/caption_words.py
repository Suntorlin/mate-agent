#!/usr/bin/env python3
"""Turn voiceover lines with known start/duration into timeline caption entries with word timing.

  caption_words.py lines.json > captions.json

lines.json: [{"text": "This changed my morning", "start": 2.5, "duration": 1.9,
              "style": "highlight", "position": "lower"}, ...]
`start`/`duration` are where that line's voiceover clip sits on the timeline (ffprobe the TTS
file). Words are split on spaces; write CJK lines with spaces or "|" between words
("这个|产品|真的|太好用了"), otherwise each run of CJK text is one word. Without ASR word timestamps, each word gets a share of the line proportional to its spoken length
(CJK characters count as one syllable, Latin words as letters / 3), with a short pause after
punctuation. Paste the output array into timeline.json "captions".
"""

from __future__ import annotations

import json
import re
import sys

CJK = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]")
PAUSE_AFTER = re.compile(
    r"[,.!?;:\uff0c\u3002\uff01\uff1f\uff1b\uff1a\u2026]$"
)  # incl. CJK punctuation
PAUSE_WEIGHT = 0.6
OPTIONAL_KEYS = ("style", "position", "fontSize", "color", "highlightColor")


def weight(word: str) -> float:
    cjk = len(CJK.findall(word))
    latin = len(re.findall(r"[^\W_]", CJK.sub("", word)))
    return max(1.0, cjk + latin / 3)


def split_words(text: str) -> list[str]:
    return [word for word in re.split(r"[\s|]+", text.strip()) if word]


def caption(line: dict) -> dict:
    words = split_words(line["text"])
    if not words:
        raise ValueError(f"empty caption line: {line!r}")
    start, duration = float(line["start"]), float(line["duration"])
    weights = [weight(word) + (PAUSE_WEIGHT if PAUSE_AFTER.search(word) else 0) for word in words]
    total = sum(weights)
    cursor, timed = start, []
    for word, share in zip(words, weights, strict=True):
        end = cursor + duration * share / total
        timed.append({"text": word, "start": round(cursor, 3), "end": round(end, 3)})
        cursor = end
    timed[-1]["end"] = round(start + duration, 3)
    entry = {"words": timed}
    entry.update({key: line[key] for key in OPTIONAL_KEYS if key in line})
    return entry


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: caption_words.py lines.json > captions.json")
    with open(sys.argv[1], encoding="utf-8") as file:
        lines = json.load(file)
    json.dump([caption(line) for line in lines], sys.stdout, ensure_ascii=False, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
