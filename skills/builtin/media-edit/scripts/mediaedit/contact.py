"""media-edit contact: a timecoded contact sheet (one JPEG) to look at a video quickly.

Frames every N seconds (default: about 24 frames over the video) or one per shot from scenes.json.
"""

from __future__ import annotations

import json
import math
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .common import Timer, emit, font_file, probe

THUMB_WIDTH = 320


def timecode(seconds: float) -> str:
    minutes, rest = divmod(seconds, 60)
    return f"{int(minutes):02d}:{rest:04.1f}"


def pick_times(
    duration: float, every: float | None, scenes: str | None, count: int = 24
) -> list[float]:
    if scenes:
        shots = json.loads(Path(scenes).read_text())
        return [round(min(s["start"] + 0.5 * s["duration"], s["start"] + 1.0), 3) for s in shots]
    step = every or max(1.0, duration / count)
    return [round(step * (i + 0.5), 3) for i in range(max(1, math.floor(duration / step)))]


def grab(source: str, at: float, path: str) -> str:
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-nostdin",
            "-y",
            "-ss",
            f"{at:.3f}",
            "-i",
            source,
            "-frames:v",
            "1",
            "-vf",
            f"scale={THUMB_WIDTH}:-2",
            path,
        ],
        check=True,
    )
    return path


def add_parser(sub) -> None:
    p = sub.add_parser("contact", help="timecoded contact sheet JPEG")
    p.add_argument("input")
    p.add_argument("-o", "--output", help="default <input>.contact.jpg")
    p.add_argument("--every", type=float, help="seconds between frames (default: ~24 frames)")
    p.add_argument("--scenes", help="scenes.json from `media-edit scenes`: one frame per shot")
    p.add_argument("--cols", type=int, help="columns (default 6 landscape, 8 portrait)")
    p.set_defaults(func=main)


def main(args) -> None:
    from PIL import Image, ImageDraw, ImageFont

    timer = Timer()
    out = Path(args.output or f"{args.input}.contact.jpg")
    info = probe(args.input)
    times = pick_times(info.duration, args.every, args.scenes)
    with tempfile.TemporaryDirectory() as tmp, ThreadPoolExecutor(8) as pool:
        paths = list(
            pool.map(lambda it: grab(args.input, it[1], f"{tmp}/{it[0]:04d}.jpg"), enumerate(times))
        )
        thumbs = [Image.open(p).convert("RGB") for p in paths if Path(p).exists()]
    cols = args.cols or (8 if info.height > info.width else 6)
    w, h = thumbs[0].size
    rows = math.ceil(len(thumbs) / cols)
    header = 36
    sheet = Image.new("RGB", (cols * w, rows * h + header), "black")
    path, index = font_file("Noto Sans CJK SC:bold")
    font = ImageFont.truetype(path, 20, index=index)
    draw = ImageDraw.Draw(sheet)
    draw.text(
        (8, 6),
        f"{Path(args.input).name}  {timecode(info.duration)}  {info.width}x{info.height}",
        fill="white",
        font=font,
    )
    for i, (thumb, at) in enumerate(zip(thumbs, times, strict=False)):
        x, y = i % cols * w, header + i // cols * h
        sheet.paste(thumb, (x, y))
        label = timecode(at)
        box = draw.textbbox((x + 6, y + h - 30), label, font=font)
        draw.rectangle((box[0] - 4, box[1] - 2, box[2] + 4, box[3] + 2), fill=(0, 0, 0))
        draw.text((x + 6, y + h - 30), label, fill=(255, 225, 77), font=font)
    sheet.save(out, quality=85)
    emit(
        {
            "output": str(out),
            "frames": len(thumbs),
            "grid": f"{cols}x{rows}",
            "seconds": timer.seconds(),
        }
    )
