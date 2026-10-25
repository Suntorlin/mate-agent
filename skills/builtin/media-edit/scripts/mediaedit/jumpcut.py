"""media-edit jumpcut: drop silences and filler words using ASR word timing.

Each kept span is trimmed from the source (video and audio together, snapped to the frame grid)
and the spans are concatenated with 10 ms audio fades at every joint. ffmpeg's aselect/select is
not used: it does not shorten audio the way it shortens video, so picture and sound drift apart.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import tempfile
from pathlib import Path

from .asr import MODEL_HELP, flat_words, load_or_transcribe
from .common import AAC, FASTSTART, X264, Timer, emit, ffmpeg, probe

FILLERS = {"um", "umm", "uh", "uhh", "er", "erm", "ah", "hmm", "mm", "嗯", "呃", "额", "唔"}
FADE_SECONDS = 0.01


def is_filler(word: str) -> bool:
    return re.sub(r"[\W_]+", "", word.lower()) in FILLERS


def keep_spans(
    words: list[dict],
    *,
    duration: float,
    min_gap: float = 0.35,
    pad: float = 0.1,
    drop_fillers: bool = True,
    fps: float | None = None,
    drop: list[tuple[float, float]] = (),
) -> list[tuple[float, float]]:
    """Spans to keep: every word +/- pad, merged when the silence between them is < min_gap.

    A dropped filler is a hard cut: the padding of the words beside it stops at its edges and no
    merge reaches across it, or a short "嗯" between two words would come back inside the merge.
    `drop` ranges (a retake, a false start) are cut the same way, with every word inside them.
    """

    def dropped(w: dict) -> bool:
        return any(a <= (w["start"] + w["end"]) / 2 <= b for a, b in drop)

    fillers = sorted(
        [(w["start"], w["end"]) for w in words if drop_fillers and is_filler(w["word"])]
        + [(float(a), float(b)) for a, b in drop]
    )
    filler_ends = {f_end for _, f_end in fillers}
    filler_starts = {f_start for f_start, _ in fillers}
    spans = []
    for w in words:
        if (drop_fillers and is_filler(w["word"])) or dropped(w):
            continue
        start, end = max(0.0, w["start"] - pad), min(duration, w["end"] + pad)
        for f_start, f_end in fillers:
            if f_end <= w["start"]:
                start = max(start, f_end)
            elif f_start >= w["end"]:
                end = min(end, f_start)
        spans.append((start, end))
    spans.sort()
    if fps:  # whole frames, so every segment's video and audio have the same length
        # Outward, except an edge against a filler, which rounds away from the filler.
        snap_start = lambda a: (math.ceil if a in filler_ends else math.floor)(a * fps) / fps  # noqa: E731
        snap_end = lambda b: (math.floor if b in filler_starts else math.ceil)(b * fps) / fps  # noqa: E731
        spans = [(snap_start(a), min(duration, snap_end(b))) for a, b in spans]
    merged: list[list[float]] = []
    for start, end in spans:
        between_filler = merged and any(
            merged[-1][1] - 1e-9 <= f_start and f_end <= start + 1e-9 for f_start, f_end in fillers
        )
        if merged and start - merged[-1][1] < min_gap and not between_filler:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return [(round(a, 4), round(b, 4)) for a, b in merged if b - a > 2 * FADE_SECONDS]


def filter_script(spans: list[tuple[float, float]], *, video: bool, audio: bool = True) -> str:
    n = len(spans)
    parts = []
    if video:
        parts.append(f"[0:v]split={n}" + "".join(f"[vs{i}]" for i in range(n)) + ";")
    if audio:
        parts.append(f"[0:a]asplit={n}" + "".join(f"[as{i}]" for i in range(n)) + ";")
    for i, (a, b) in enumerate(spans):
        if video:
            parts.append(f"[vs{i}]trim=start={a}:end={b},setpts=PTS-STARTPTS[v{i}];")
        if audio:
            fade_out = round(b - a - FADE_SECONDS, 4)
            parts.append(
                f"[as{i}]atrim=start={a}:end={b},asetpts=PTS-STARTPTS,"
                f"afade=t=in:d={FADE_SECONDS},afade=t=out:st={fade_out}:d={FADE_SECONDS}[a{i}];"
            )
    inputs = "".join((f"[v{i}]" if video else "") + (f"[a{i}]" if audio else "") for i in range(n))
    outputs = ("[v]" if video else "") + ("[a]" if audio else "")
    parts.append(f"{inputs}concat=n={n}:v={int(video)}:a={int(audio)}{outputs}")
    return "".join(parts)


def remap_words(words: list[dict], spans: list[tuple[float, float]]) -> list[dict]:
    """Word times on the cut timeline (words outside every span are dropped)."""
    out, offset = [], 0.0
    for a, b in spans:
        for w in words:
            if w["start"] >= a and w["end"] <= b + 1e-6:
                out.append(
                    {
                        **w,
                        "start": round(w["start"] - a + offset, 3),
                        "end": round(w["end"] - a + offset, 3),
                    }
                )
        offset += b - a
    return out


def add_parser(sub) -> None:
    p = sub.add_parser("jumpcut", help="remove silences and filler words (ASR word timing)")
    p.add_argument("input")
    p.add_argument("-o", "--output", help="default <input>.jumpcut.mp4")
    p.add_argument(
        "--gap", type=float, default=0.35, help="shortest silence to remove, seconds (0.35)"
    )
    p.add_argument(
        "--pad", type=float, default=0.1, help="breath kept around each word, seconds (0.1)"
    )
    p.add_argument("--keep-fillers", action="store_true", help="keep um/uh/嗯/呃")
    p.add_argument(
        "--drop",
        action="append",
        default=[],
        type=parse_range,
        metavar="START-END",
        help="also cut this range of the source, seconds (a retake, a false start); repeatable",
    )
    p.add_argument("--words", help="reuse a words.json instead of running ASR")
    p.add_argument("--model", default="turbo", help=MODEL_HELP)
    p.add_argument("--lang")
    p.set_defaults(func=main)


def parse_range(text: str) -> tuple[float, float]:
    start, _, end = text.partition("-")
    try:
        a, b = float(start), float(end)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not START-END in seconds: {text!r}") from None
    if b <= a:
        raise argparse.ArgumentTypeError(f"END must be after START: {text!r}")
    return a, b


def main(args) -> None:
    timer = Timer()
    source = Path(args.input)
    out = Path(args.output or source.with_name(source.stem + ".jumpcut.mp4"))
    out.parent.mkdir(parents=True, exist_ok=True)
    info = probe(source)
    if not info.has_audio:
        raise SystemExit("jumpcut needs an audio track")
    data = load_or_transcribe(
        str(source), args.words, args.model, args.lang, out.with_suffix(".source-words.json")
    )
    words = flat_words(data)
    spans = keep_spans(
        words,
        duration=info.duration,
        min_gap=args.gap,
        pad=args.pad,
        drop_fillers=not args.keep_fillers,
        fps=info.fps if info.has_video else None,
        drop=args.drop,
    )
    if not spans:
        raise SystemExit("no speech found")
    with tempfile.NamedTemporaryFile("w", suffix=".fc", delete=False) as script:
        script.write(filter_script(spans, video=info.has_video))
    maps = (["-map", "[v]", *X264] if info.has_video else []) + ["-map", "[a]", *AAC]
    ffmpeg("-i", str(source), "-/filter_complex", script.name, *maps, *FASTSTART, str(out))
    Path(script.name).unlink()
    kept = sum(b - a for a, b in spans)
    remapped = {
        "language": data.get("language"),
        "duration": kept,
        "model": data.get("model"),
        "segments": [{"start": 0, "end": kept, "text": "", "words": remap_words(words, spans)}],
    }
    words_out = out.with_suffix(".words.json")
    words_out.write_text(json.dumps(remapped, ensure_ascii=False, indent=1), encoding="utf-8")
    out.with_suffix(".spans.json").write_text(json.dumps(spans))
    emit(
        {
            "output": str(out),
            "words": str(words_out),
            "segments_kept": len(spans),
            "source_s": round(info.duration, 2),
            "kept_s": round(kept, 2),
            "removed_s": round(info.duration - kept, 2),
            "removed_pct": round(100 * (1 - kept / info.duration), 1),
            "output_s": round(probe(out).duration, 2),
            "seconds": timer.seconds(),
        }
    )
