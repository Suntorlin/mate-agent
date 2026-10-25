"""media-edit beatcut: cut a list of clips (or images) to the beat of a music track.

librosa finds the beats; every shot lasts --every beats (2 by default), so each cut lands on a
beat. Shot lengths are counted in whole frames from the beat times, so the cuts do not drift.
"""

from __future__ import annotations

import json
import tempfile
from itertools import pairwise
from pathlib import Path

from .common import AAC, FASTSTART, X264, Timer, emit, ffmpeg, parse_size, probe

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}


def detect_beats(music: str) -> tuple[float, list[float]]:
    import librosa
    import numpy as np

    samples, rate = librosa.load(music, sr=22050, mono=True)
    tempo, beats = librosa.beat.beat_track(y=samples, sr=rate, units="time")
    return float(np.atleast_1d(tempo)[0]), [float(b) for b in beats]


def cut_marks(beats: list[float], shots: int, every: int, start: float = 0.0) -> list[float]:
    """shots + 1 beat times, every `every` beats from the first beat at or after `start`;
    extrapolated with the median beat interval when the track runs out of beats."""
    usable = [b for b in beats if b >= start]
    if len(usable) < 2:
        raise SystemExit("not enough beats found in the music")
    intervals = sorted(b2 - b1 for b1, b2 in pairwise(usable))
    period = intervals[len(intervals) // 2]
    marks = []
    for i in range(shots + 1):
        k = i * every
        marks.append(usable[k] if k < len(usable) else usable[-1] + (k - len(usable) + 1) * period)
    return marks


def shot_frames(marks: list[float], fps: int) -> list[int]:
    """Whole-frame shot lengths whose running total always sits on the nearest beat frame."""
    origin = marks[0]
    edges = [round((m - origin) * fps) for m in marks]
    return [b - a for a, b in pairwise(edges)]


def add_parser(sub) -> None:
    p = sub.add_parser("beatcut", help="cut clips to the beat of a music track")
    p.add_argument("music")
    p.add_argument("clips", nargs="+", help="videos or images, in order")
    p.add_argument("-o", "--output", default="beatcut.mp4")
    p.add_argument("--every", type=int, default=2, help="beats per shot (2)")
    p.add_argument(
        "--shots", type=int, help="number of shots (default: one per clip; clips repeat)"
    )
    p.add_argument(
        "--music-start", type=float, default=0.0, help="start at the first beat after this time"
    )
    p.add_argument(
        "--clip-start", type=float, default=0.0, help="seconds skipped at the start of each video"
    )
    p.add_argument("--size", default="1080x1920")
    p.add_argument("--fps", type=int, default=30)
    p.set_defaults(func=main)


def main(args) -> None:
    timer = Timer()
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    width, height = parse_size(args.size)
    tempo, beats = detect_beats(args.music)
    shots = args.shots or len(args.clips)
    marks = cut_marks(beats, shots, args.every, args.music_start)
    frames = shot_frames(marks, args.fps)
    inputs, chains = [], []
    for i, count in enumerate(frames):
        clip = args.clips[i % len(args.clips)]
        seconds = count / args.fps
        if Path(clip).suffix.lower() in IMAGE_SUFFIXES:
            inputs += [
                "-loop",
                "1",
                "-framerate",
                str(args.fps),
                "-t",
                f"{seconds + 0.5:.3f}",
                "-i",
                clip,
            ]
        else:
            skip = min(args.clip_start, max(0.0, probe(clip).duration - seconds))
            inputs += ["-ss", f"{skip:.3f}", "-t", f"{seconds + 0.5:.3f}", "-i", clip]
        chains.append(
            f"[{i}:v]scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},"
            f"setsar=1,fps={args.fps},tpad=stop_mode=clone:stop_duration=1,trim=end_frame={count},"
            f"setpts=PTS-STARTPTS[v{i}]"
        )
    total = sum(frames) / args.fps
    music = len(frames)
    graph = ";".join(chains) + ";" + "".join(f"[v{i}]" for i in range(len(frames)))
    graph += f"concat=n={len(frames)}:v=1:a=0[v];"
    graph += (
        f"[{music}:a]atrim=start={marks[0]:.4f}:duration={total:.4f},asetpts=PTS-STARTPTS,"
        f"afade=t=out:st={max(0.0, total - 0.5):.4f}:d=0.5[a]"
    )
    with tempfile.NamedTemporaryFile("w", suffix=".fc", delete=False) as script:
        script.write(graph)
    ffmpeg(
        *inputs,
        "-i",
        args.music,
        "-/filter_complex",
        script.name,
        "-map",
        "[v]",
        "-map",
        "[a]",
        *X264,
        *AAC,
        *FASTSTART,
        str(out),
    )
    Path(script.name).unlink()
    cuts = [round(sum(frames[:i]) / args.fps, 3) for i in range(1, len(frames))]
    out.with_suffix(".beats.json").write_text(
        json.dumps({"tempo": tempo, "beats": beats, "marks": marks, "cuts": cuts})
    )
    emit(
        {
            "output": str(out),
            "tempo_bpm": round(tempo, 1),
            "beats": len(beats),
            "shots": len(frames),
            "duration_s": round(total, 3),
            "cuts_s": cuts,
            "seconds": timer.seconds(),
        }
    )
