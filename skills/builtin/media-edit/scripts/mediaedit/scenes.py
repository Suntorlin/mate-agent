"""media-edit scenes: shot/cut detection with PySceneDetect; writes scenes.json.

`content` (default) catches hard cuts; `adaptive` is steadier on fast camera motion. Neither
reliably finds slow dissolves or graphics fading in; check the contact sheet.
"""

from __future__ import annotations

import json
from pathlib import Path

from .common import Timer, emit


def detect_scenes(
    source: str, detector: str = "content", threshold: float | None = None, min_seconds: float = 0.4
) -> list[dict]:
    from scenedetect import AdaptiveDetector, ContentDetector, SceneManager, open_video

    video = open_video(source)
    min_frames = max(1, round(min_seconds * video.frame_rate))
    if detector == "adaptive":
        found = AdaptiveDetector(adaptive_threshold=threshold or 3.0, min_scene_len=min_frames)
    else:
        found = ContentDetector(threshold=threshold or 27.0, min_scene_len=min_frames)
    manager = SceneManager()
    manager.auto_downscale = True
    manager.add_detector(found)
    manager.detect_scenes(video, show_progress=False)
    scenes = manager.get_scene_list(start_in_scene=True)
    return [
        {
            "index": i + 1,
            "start": round(start.get_seconds(), 3),
            "end": round(end.get_seconds(), 3),
            "duration": round(end.get_seconds() - start.get_seconds(), 3),
        }
        for i, (start, end) in enumerate(scenes)
    ]


def add_parser(sub) -> None:
    p = sub.add_parser("scenes", help="detect shots/cuts -> scenes.json")
    p.add_argument("input")
    p.add_argument("-o", "--output", help="default <input>.scenes.json")
    p.add_argument("--detector", choices=("content", "adaptive"), default="content")
    p.add_argument("--threshold", type=float, help="content: 27 (lower = more cuts); adaptive: 3")
    p.add_argument("--min-shot", type=float, default=0.4, help="shortest shot, seconds (0.4)")
    p.set_defaults(func=main)


def main(args) -> None:
    timer = Timer()
    out = Path(args.output or f"{args.input}.scenes.json")
    scenes = detect_scenes(args.input, args.detector, args.threshold, args.min_shot)
    out.write_text(json.dumps(scenes, indent=1))
    emit(
        {
            "output": str(out),
            "shots": len(scenes),
            "cuts_s": [s["start"] for s in scenes[1:]],
            "seconds": timer.seconds(),
        }
    )
