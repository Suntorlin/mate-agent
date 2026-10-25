#!/usr/bin/env python3
"""Break a reference short video into shots with ffprobe + ffmpeg scene detection.

  analyze_reference.py <reference.mp4> <out-dir> [--threshold 0.3] [--fade-threshold 0.25]

Writes into <out-dir>:
  meta.json          duration, size, fps, audio presence
  shots.json         [{index, start, end, duration, transition_in}] in seconds; transition_in is
                     "cut" (hard cut) or "dissolve" (crossfade/fade, found at 3 fps, ±0.3 s)
  keyframes/NN.jpg   one mid-shot frame per shot (540 px wide), hook.jpg at 0.5 s
  contact.jpg        all keyframes tiled 4 per row, to look at the whole edit at once
  audio.m4a          mono 16 kHz speech track for speech_to_text (only if the video has audio)
Prints a shot table. Lower the thresholds if obvious cuts are missed; raise them if camera
motion is reported as cuts.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import subprocess
import sys
from itertools import pairwise
from pathlib import Path

KEYFRAME_WIDTH = 540
CONTACT_COLUMNS = 4
# Dissolves change the picture a little per frame, so they are looked for at a low frame rate.
DISSOLVE_SAMPLE_FPS = 3
DISSOLVE_MERGE_SECONDS = 0.5


def run(*command: str) -> str:
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        sys.exit(f"command failed: {' '.join(command)}\n{result.stderr[-2000:]}")
    return result.stdout + result.stderr


def probe(path: Path) -> dict:
    data = json.loads(
        run(
            "ffprobe",
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(path),
        )
    )
    video = next((s for s in data["streams"] if s["codec_type"] == "video"), None)
    if video is None:
        sys.exit(f"{path} has no video stream")
    numerator, denominator = (int(x) for x in video.get("avg_frame_rate", "0/1").split("/"))
    return {
        "duration": float(data["format"]["duration"]),
        "width": int(video["width"]),
        "height": int(video["height"]),
        "fps": round(numerator / denominator, 3) if denominator else None,
        "has_audio": any(s["codec_type"] == "audio" for s in data["streams"]),
    }


def scene_changes(path: Path, video_filter: str) -> list[float]:
    output = run(
        "ffmpeg",
        "-hide_banner",
        "-nostats",
        "-i",
        str(path),
        "-filter:v",
        f"{video_filter},showinfo",
        "-an",
        "-f",
        "null",
        "-",
    )
    return [float(match) for match in re.findall(r"showinfo.*?pts_time:([0-9.]+)", output)]


def detect_cuts(path: Path, threshold: float, fade_threshold: float) -> dict[float, str]:
    cuts = dict.fromkeys(scene_changes(path, f"select='gt(scene,{threshold})'"), "cut")
    dissolves = scene_changes(
        path, f"fps={DISSOLVE_SAMPLE_FPS},scale=270:-2,select='gt(scene,{fade_threshold})'"
    )
    for time in dissolves:
        if all(abs(time - cut) > DISSOLVE_MERGE_SECONDS for cut in cuts):
            cuts[time] = "dissolve"
    return cuts


def build_shots(cuts: dict[float, str], duration: float, min_shot: float) -> list[dict]:
    bounds = [(0.0, "start")]
    for cut in sorted(cuts):
        if cut - bounds[-1][0] >= min_shot and duration - cut >= min_shot:
            bounds.append((cut, cuts[cut]))
    bounds.append((duration, "end"))
    return [
        {
            "index": index + 1,
            "start": round(start, 3),
            "end": round(end, 3),
            "duration": round(end - start, 3),
            "transition_in": kind if index else "start",
        }
        for index, ((start, kind), (end, _)) in enumerate(pairwise(bounds))
    ]


def frame(path: Path, at: float, destination: Path) -> None:
    run(
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        f"{at:.3f}",
        "-i",
        str(path),
        "-frames:v",
        "1",
        "-vf",
        f"scale={KEYFRAME_WIDTH}:-2",
        "-q:v",
        "3",
        str(destination),
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("reference", type=Path)
    parser.add_argument("out_dir", type=Path)
    parser.add_argument("--threshold", type=float, default=0.3)
    parser.add_argument("--fade-threshold", type=float, default=0.25)
    parser.add_argument("--min-shot", type=float, default=0.25)
    args = parser.parse_args()
    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            sys.exit(f"{tool} is not installed")

    meta = probe(args.reference)
    keyframes = args.out_dir / "keyframes"
    keyframes.mkdir(parents=True, exist_ok=True)
    cuts = detect_cuts(args.reference, args.threshold, args.fade_threshold)
    shots = build_shots(cuts, meta["duration"], args.min_shot)
    for shot in shots:
        frame(
            args.reference,
            (shot["start"] + shot["end"]) / 2,
            keyframes / f"{shot['index']:02d}.jpg",
        )
    frame(args.reference, min(0.5, meta["duration"] / 2), keyframes / "hook.jpg")
    rows = math.ceil(len(shots) / CONTACT_COLUMNS)
    columns = min(CONTACT_COLUMNS, len(shots))
    run(
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-framerate",
        "1",
        "-i",
        str(keyframes / "%02d.jpg"),
        "-vf",
        f"scale=270:-2,tile={columns}x{rows}:padding=4",
        "-frames:v",
        "1",
        str(args.out_dir / "contact.jpg"),
    )
    if meta["has_audio"]:
        run(
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(args.reference),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "aac",
            "-b:a",
            "64k",
            str(args.out_dir / "audio.m4a"),
        )
    meta["shot_count"] = len(shots)
    (args.out_dir / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    (args.out_dir / "shots.json").write_text(json.dumps(shots, indent=2) + "\n")

    print(
        f"{args.reference}: {meta['width']}x{meta['height']} @ {meta['fps']} fps, "
        f"{meta['duration']:.2f}s, audio={'yes' if meta['has_audio'] else 'no'}, {len(shots)} shots"
    )
    for shot in shots:
        print(
            f"  {shot['index']:>2}  {shot['start']:7.2f} → {shot['end']:7.2f}  "
            f"({shot['duration']:.2f}s)  {shot['transition_in']}"
        )
    print(f"wrote {args.out_dir}/meta.json, shots.json, keyframes/, contact.jpg")


if __name__ == "__main__":
    main()
