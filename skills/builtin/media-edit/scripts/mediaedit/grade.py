"""media-edit grade: correct the color of the user's footage, compare looks side by side, apply one.

Without --look it writes a preview sheet: three moments of the video (rows) under every look
(columns), each frame rendered by the same ffmpeg filter the final grade uses, and measures the
skin in each (hue and saturation where YCbCr says skin) so a look that turns faces red or orange
is flagged. With --look it grades the whole video; audio is copied.

Every look starts from the same correction measured on the footage: a gray-world white balance
applied at 60% (a red wall should stay a little red) and black/white points from the 0.5/99.5%
luma percentiles, never stretched by more than 8% at either end.
"""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

from .common import X264, Timer, emit, ffmpeg, font_file, probe

SAMPLE_POINTS = (0.2, 0.5, 0.8)
SAMPLE_WIDTH = 480
WB_STRENGTH = 0.6
WB_LIMITS = (0.85, 1.18)
LEVEL_LIMIT = 0.08
# Natural skin sits around hue 8-30 degrees; below reads red or magenta, above yellow, and past
# 0.6 saturation it reads orange. A guide for the eye, not a verdict.
SKIN_HUE = (5.0, 32.0)
SKIN_MAX_SATURATION = 0.6
SKIN_MIN_FRACTION = 0.01

LOOKS = {
    "original": ("Original", None),
    "base": ("Corrected only", ""),
    "natural": ("Natural", "eq=contrast=1.05:saturation=1.08"),
    "warm": (
        "Warm",
        "colorbalance=rs=0.04:bs=-0.04:rm=0.03:bm=-0.03,eq=saturation=1.05",
    ),
    "cool": ("Cool", "colorbalance=rs=-0.03:bs=0.04:rm=-0.02:bm=0.03"),
    "film": (
        "Soft film",
        "curves=all='0/0.04 0.5/0.5 1/0.96',eq=contrast=0.97:saturation=0.92,"
        "colorbalance=rs=-0.02:bs=0.04:rh=0.03:bh=-0.03",
    ),
    "vivid": ("Vivid", "eq=contrast=1.12:saturation=1.25"),
}


def grab_rgb(source: str, at: float, width: int = SAMPLE_WIDTH):
    """One frame as an RGB float array in 0..1."""
    import numpy as np

    info = probe(source)
    height = round(info.height * width / info.width / 2) * 2
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-nostdin", "-ss", f"{at:.3f}", "-i", source, "-frames:v", "1",
         "-vf", f"scale={width}:{height}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True, check=True,
    ).stdout  # fmt: skip
    return np.frombuffer(raw, np.uint8).reshape(height, width, 3).astype(np.float32) / 255


def measure_correction(frames) -> dict:
    """White-balance gains (red, blue against green) and black/white points from sample frames."""
    import numpy as np

    pixels = np.concatenate([f.reshape(-1, 3) for f in frames])
    luma = pixels @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    mid = pixels[(luma > 0.08) & (luma < 0.92)]
    means = mid.mean(axis=0) if len(mid) else np.array([0.5, 0.5, 0.5])

    def gain(channel: float) -> float:
        full = min(max(float(means[1]) / max(float(channel), 1e-3), WB_LIMITS[0]), WB_LIMITS[1])
        return round(1 + WB_STRENGTH * (full - 1), 3)

    low, high = np.percentile(luma, [0.5, 99.5])
    return {
        "red_gain": gain(means[0]),
        "blue_gain": gain(means[2]),
        "black": round(float(min(max(low, 0.0), LEVEL_LIMIT)), 3),
        "white": round(float(max(min(high, 1.0), 1 - LEVEL_LIMIT)), 3),
    }


def base_filter(c: dict) -> str:
    lo, hi = c["black"], c["white"]
    return (
        f"colorchannelmixer=rr={c['red_gain']}:gg=1:bb={c['blue_gain']},"
        f"colorlevels=rimin={lo}:gimin={lo}:bimin={lo}:rimax={hi}:gimax={hi}:bimax={hi}"
    )


def look_filter(look: str, correction: dict) -> str | None:
    """The whole filter for a look, or None for the untouched original."""
    if look not in LOOKS:
        raise SystemExit(f"unknown look {look!r}; one of {', '.join(LOOKS)}")
    extra = LOOKS[look][1]
    if extra is None:
        return None
    return ",".join(part for part in (base_filter(correction), extra) if part)


def skin_stats(image) -> dict | None:
    """Mean hue (degrees) and saturation of the skin-colored pixels, or None without skin."""
    import numpy as np

    ycbcr = np.asarray(image.convert("YCbCr"), np.float32)
    y, cb, cr = ycbcr[..., 0], ycbcr[..., 1], ycbcr[..., 2]
    mask = (cb >= 77) & (cb <= 127) & (cr >= 133) & (cr <= 173) & (y > 60)
    if mask.mean() < SKIN_MIN_FRACTION:
        return None
    hsv = np.asarray(image.convert("HSV"), np.float32)
    hue = hsv[..., 0][mask] * 360 / 255
    hue = np.where(hue > 180, hue - 360, hue)  # reds just below 0 count as negative, not 350
    return {
        "hue": round(float(hue.mean()), 1),
        "saturation": round(float(hsv[..., 1][mask].mean() / 255), 2),
    }


def skin_warning(stats: dict | None) -> str | None:
    if stats is None:
        return None
    if stats["hue"] < SKIN_HUE[0]:
        return "skin reads red"
    if stats["hue"] > SKIN_HUE[1]:
        return "skin reads yellow"
    if stats["saturation"] > SKIN_MAX_SATURATION:
        return "skin reads orange"
    return None


def render_still(source_png: str, vf: str | None, out_png: str) -> str:
    ffmpeg("-i", source_png, *(["-vf", vf] if vf else []), out_png)
    return out_png


def preview(args, info, timer) -> None:
    from PIL import Image, ImageDraw, ImageFont

    out = Path(args.output or f"{args.input}.grade.jpg")
    times = [round(info.duration * p, 3) for p in SAMPLE_POINTS]
    frames = [grab_rgb(args.input, at) for at in times]
    correction = measure_correction(frames)
    looks = list(LOOKS)
    results = {}
    with tempfile.TemporaryDirectory() as tmp:
        sources = []
        for i, frame in enumerate(frames):
            path = f"{tmp}/src{i}.png"
            Image.fromarray((frame * 255).round().astype("uint8")).save(path)
            sources.append(path)
        tiles = {}
        for look in looks:
            vf = look_filter(look, correction)
            images = [
                Image.open(render_still(src, vf, f"{tmp}/{look}{i}.png")).convert("RGB")
                for i, src in enumerate(sources)
            ]
            tiles[look] = images
            stats = [skin_stats(img) for img in images]
            found = [s for s in stats if s]
            mean = (
                {
                    "hue": round(sum(s["hue"] for s in found) / len(found), 1),
                    "saturation": round(sum(s["saturation"] for s in found) / len(found), 2),
                }
                if found
                else None
            )
            results[look] = {"label": LOOKS[look][0], "skin": mean, "warning": skin_warning(mean)}
    w, h = tiles[looks[0]][0].size
    header = 34
    sheet = Image.new("RGB", (len(looks) * w, header + len(times) * h), "black")
    path, index = font_file("Noto Sans CJK SC:bold")
    font = ImageFont.truetype(path, 18, index=index)
    draw = ImageDraw.Draw(sheet)
    for col, look in enumerate(looks):
        result = results[look]
        title = f"{look}" + (f"  ! {result['warning']}" if result["warning"] else "")
        draw.text((col * w + 8, 7), title, fill=(255, 120, 90) if result["warning"] else "white", font=font)  # fmt: skip
        for row, image in enumerate(tiles[look]):
            sheet.paste(image, (col * w, header + row * h))
    sheet.save(out, quality=88)
    Path(f"{out}.json").write_text(json.dumps(correction))
    emit(
        {
            "preview": str(out),
            "times": times,
            "correction": correction,
            "looks": results,
            "seconds": timer.seconds(),
        }
    )


def apply(args, info, timer) -> None:
    source = Path(args.input)
    out = Path(args.output or source.with_name(f"{source.stem}.graded{source.suffix}"))
    out.parent.mkdir(parents=True, exist_ok=True)
    frames = [grab_rgb(args.input, round(info.duration * p, 3)) for p in SAMPLE_POINTS]
    correction = measure_correction(frames)
    vf = look_filter(args.look, correction)
    if vf is None:
        raise SystemExit("the original look changes nothing; skip grading instead")
    audio = ["-map", "0:a:0?", "-c:a", "copy"]
    ffmpeg("-i", str(source), "-map", "0:v:0", "-vf", vf, *X264, *audio, str(out))
    emit(
        {
            "output": str(out),
            "look": args.look,
            "correction": correction,
            "filter": vf,
            "seconds": timer.seconds(),
        }
    )


def add_parser(sub) -> None:
    p = sub.add_parser("grade", help="color correction: preview looks side by side, apply one")
    p.add_argument("input")
    p.add_argument(
        "-o", "--output", help="preview: <input>.grade.jpg; with --look: <input>.graded.<ext>"
    )
    p.add_argument("--look", help=f"apply this look to the whole video: {', '.join(LOOKS)}")
    p.set_defaults(func=main)


def main(args) -> None:
    timer = Timer()
    info = probe(args.input)
    if not info.has_video:
        raise SystemExit("grade needs a video")
    if args.look:
        apply(args, info, timer)
    else:
        preview(args, info, timer)
