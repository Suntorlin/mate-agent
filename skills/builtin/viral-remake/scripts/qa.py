#!/usr/bin/env python3
"""Check a rendered remake against its timeline and the reference edit.

  qa.py <final.mp4> <timeline.json> [--reference-shots reference/shots.json] [--frames-dir DIR]

Checks: H.264 yuv420p video at the timeline's canvas size, duration within 0.1 s of the
timeline, an audio stream when the timeline has audio, and (with --reference-shots) the same
shot count with every shot within ±20% of the reference shot duration. Extracts three frames
(hook, middle, end) as PNG so you can look at them. Exit code 1 lists every failed check.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

DURATION_TOLERANCE_SECONDS = 0.1
SHOT_TOLERANCE = 0.2


def probe(path: Path) -> dict:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(path),
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode:
        sys.exit(f"ffprobe failed for {path}: {result.stderr.strip()}")
    return json.loads(result.stdout)


def timeline_shots(timeline: dict) -> list[float]:
    """Shot durations in timeline order."""
    return [float(shot["duration"]) for shot in timeline["shots"]]


def timeline_seconds(timeline: dict) -> float:
    cursor, end = 0.0, 0.0
    for shot in timeline["shots"]:
        start = float(shot.get("start", cursor))
        cursor = start + float(shot["duration"])
        end = max(end, cursor)
    return end


def check_stream(info: dict, timeline: dict) -> list[str]:
    failures = []
    canvas = {"width": 1080, "height": 1920, **timeline.get("canvas", {})}
    video = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    if video is None:
        return ["no video stream"]
    if (video["width"], video["height"]) != (canvas["width"], canvas["height"]):
        failures.append(
            f"size {video['width']}x{video['height']} != canvas {canvas['width']}x{canvas['height']}"
        )
    if video.get("codec_name") != "h264" or video.get("pix_fmt") != "yuv420p":
        failures.append(
            f"video is {video.get('codec_name')}/{video.get('pix_fmt')}, expected h264/yuv420p"
        )
    duration = float(info["format"]["duration"])
    expected = timeline_seconds(timeline)
    if abs(duration - expected) > DURATION_TOLERANCE_SECONDS:
        failures.append(
            f"duration {duration:.3f}s differs from timeline {expected:.3f}s by more than 0.1s"
        )
    has_audio = any(s["codec_type"] == "audio" for s in info["streams"])
    if timeline.get("audio") and not has_audio:
        failures.append("timeline has audio tracks but the file has no audio stream")
    return failures


def check_shots(planned: list[float], reference: list[dict]) -> tuple[list[str], list[str]]:
    rows, failures = [], []
    if len(planned) != len(reference):
        failures.append(f"{len(planned)} shots vs {len(reference)} in the reference")
    for index, (mine, theirs) in enumerate(
        zip(planned, (r["duration"] for r in reference), strict=False), start=1
    ):
        drift = (mine - theirs) / theirs if theirs else 0.0
        status = "ok" if abs(drift) <= SHOT_TOLERANCE else "FAIL"
        rows.append(
            f"  shot {index:>2}: {mine:5.2f}s vs reference {theirs:5.2f}s ({drift:+.0%}) {status}"
        )
        if status == "FAIL":
            failures.append(
                f"shot {index} is {mine:.2f}s, reference {theirs:.2f}s ({drift:+.0%}, limit ±20%)"
            )
    return rows, failures


def extract_frames(video: Path, seconds: float, directory: Path) -> list[Path]:
    directory.mkdir(parents=True, exist_ok=True)
    frames = []
    for label, at in (
        ("hook", min(1.0, seconds / 4)),
        ("middle", seconds / 2),
        ("end", max(0.0, seconds - 0.5)),
    ):
        target = directory / f"{label}.png"
        subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-ss",
                f"{at:.3f}",
                "-i",
                str(video),
                "-frames:v",
                "1",
                str(target),
            ],
            check=True,
        )
        frames.append(target)
    return frames


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("video", type=Path)
    parser.add_argument("timeline", type=Path)
    parser.add_argument("--reference-shots", type=Path)
    parser.add_argument("--frames-dir", type=Path)
    args = parser.parse_args()

    timeline = json.loads(args.timeline.read_text())
    info = probe(args.video)
    failures = check_stream(info, timeline)
    video = next(s for s in info["streams"] if s["codec_type"] == "video")
    print(
        f"{args.video}: {video['width']}x{video['height']} {video.get('codec_name')}/{video.get('pix_fmt')}, "
        f"{float(info['format']['duration']):.3f}s, audio="
        f"{'yes' if any(s['codec_type'] == 'audio' for s in info['streams']) else 'no'}, "
        f"{int(info['format']['size']) / 1e6:.1f} MB"
    )
    if args.reference_shots:
        rows, shot_failures = check_shots(
            timeline_shots(timeline), json.loads(args.reference_shots.read_text())
        )
        print("\n".join(rows))
        failures += shot_failures
    frames_dir = args.frames_dir or args.video.parent / f"{args.video.stem}-qa"
    frames = extract_frames(args.video, float(info["format"]["duration"]), frames_dir)
    print("frames to inspect: " + ", ".join(str(frame) for frame in frames))
    if failures:
        sys.stdout.flush()
        print("QA FAILED:\n" + "\n".join(f"  - {failure}" for failure in failures), file=sys.stderr)
        sys.exit(1)
    print("QA passed")


if __name__ == "__main__":
    main()
