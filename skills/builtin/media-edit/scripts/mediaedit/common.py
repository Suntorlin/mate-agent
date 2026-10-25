"""Shared helpers: ffmpeg/ffprobe calls, media info, fonts, model paths."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

MODELS = Path(os.environ.get("MEDIA_MODELS", "/opt/media/models"))
DEFAULT_FONT = "Noto Sans CJK SC:bold"
X264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]
AAC = ["-c:a", "aac", "-b:a", "192k"]
FASTSTART = ["-movflags", "+faststart"]


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def emit(result: dict) -> None:
    """Print the command's machine-readable summary on stdout."""
    print(json.dumps(result, ensure_ascii=False, indent=1))


def run(cmd: list[str], *, capture: bool = False) -> str:
    """Run a command; on failure exit with the tail of its stderr."""
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode:
        tail = "\n".join(result.stderr.strip().splitlines()[-15:])
        sys.exit(f"command failed ({result.returncode}): {' '.join(cmd[:6])} …\n{tail}")
    return result.stdout if capture else result.stderr


def ffmpeg(*args: str) -> str:
    """Run ffmpeg quietly (overwrite on); returns stderr for filters that report there."""
    return run(["ffmpeg", "-hide_banner", "-nostdin", "-y", *args])


@dataclass
class MediaInfo:
    duration: float
    width: int = 0
    height: int = 0
    fps: float = 0.0
    has_video: bool = False
    has_audio: bool = False


def probe(path: str | Path) -> MediaInfo:
    out = run(
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
        capture=True,
    )
    data = json.loads(out)
    streams = data.get("streams", [])
    video = next(
        (
            s
            for s in streams
            if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")
        ),
        None,
    )
    info = MediaInfo(
        duration=float(data.get("format", {}).get("duration") or 0),
        has_audio=any(s.get("codec_type") == "audio" for s in streams),
    )
    if video:
        num, _, den = video.get("avg_frame_rate", "0/1").partition("/")
        fps = float(num) / float(den or 1) if float(den or 1) else 0.0
        info.width, info.height = int(video["width"]), int(video["height"])
        info.fps = fps or 30.0
        info.has_video = True
    return info


def read_audio(path: str | Path, rate: int = 16000):
    """Decode the first audio stream to mono float32 at `rate` with ffmpeg (not PyAV)."""
    import numpy as np

    pcm = subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-nostdin",
            "-i",
            str(path),
            "-map",
            "0:a:0",
            "-ac",
            "1",
            "-ar",
            str(rate),
            "-f",
            "f32le",
            "-",
        ],
        capture_output=True,
        check=True,
    ).stdout
    return np.frombuffer(pcm, np.float32).copy()


def font_file(pattern: str = DEFAULT_FONT) -> tuple[str, int]:
    """Resolve a fontconfig pattern to (file path, face index); PIL and ImageMagick need a path."""
    out = run(["fc-match", "-f", "%{file}\t%{index}", pattern], capture=True)
    path, _, index = out.partition("\t")
    return path, int(index or 0)


def font_family(pattern: str = DEFAULT_FONT) -> str:
    """The family name libass should use for a fontconfig pattern."""
    out = run(["fc-match", "-f", "%{family[0]}", pattern], capture=True)
    return out.strip() or "Noto Sans CJK SC"


def parse_size(text: str) -> tuple[int, int]:
    width, _, height = text.lower().partition("x")
    return int(width), int(height)


class Timer:
    def __init__(self) -> None:
        self.start = time.monotonic()

    def seconds(self) -> float:
        return round(time.monotonic() - self.start, 2)
