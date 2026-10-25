"""media-edit loudness: normalize to -14 LUFS with a true-peak target of -1.5 dBTP, then measure the
ENCODED file and retry 0.5 dB lower while its true peak is above -1.0 dBTP.

AAC encoding raises peaks: a -1.0 dBTP target measured -0.4 after encoding, -1.5 measured -1.3.
Two-pass loudnorm (measure, then apply linearly); video is copied untouched.

A quiet source with high peaks has no room for the gain: a linear gain from -21.5 LUFS / +0.2 dBTP
to -14 LUFS puts the peaks at +7.7. loudnorm then falls back or stops short (-15.4 LUFS after four
tries). Such a source is raised by the gain and its peaks held under the target by a limiter
working at 4x the sample rate, so it is the true peak that is held; speech peaks are short, so a
few dB of limiting is not heard.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path

from .common import AAC, FASTSTART, Timer, emit, ffmpeg, probe

MAX_ATTEMPTS = 4
STEP_DB = 0.5
OVERSAMPLE_RATE = 192_000
LIMITER_HEADROOM_DB = 1.0


def needs_limiter(measured: dict, target: float, tp: float) -> bool:
    """True when the linear gain to `target` would push the source's true peak above `tp`."""
    return float(measured["input_tp"]) + (target - float(measured["input_i"])) > tp


def limiter_filter(gain_db: float, tp: float) -> str:
    """Gain, then a limiter at 4x the sample rate holding the true peak at `tp` dBTP."""
    return (
        f"volume={gain_db:.2f}dB,aresample={OVERSAMPLE_RATE},"
        f"alimiter=limit={10 ** (tp / 20):.4f}:attack=1:release=60:level=disabled,"
        "aresample=48000"
    )


def loudnorm_measure(source: str, target: float, tp: float) -> dict:
    report = ffmpeg(
        "-nostats",
        "-i",
        source,
        "-map",
        "0:a:0",
        "-af",
        f"loudnorm=I={target}:TP={tp}:LRA=11:print_format=json",
        "-f",
        "null",
        "-",
    )
    return json.loads(report[report.rindex("{") : report.rindex("}") + 1])


def apply_filter(measured: dict, target: float, tp: float) -> str:
    lra = min(
        50, max(11, math.ceil(float(measured["input_lra"])) + 1)
    )  # linear needs LRA >= source
    return (
        f"loudnorm=I={target}:TP={tp}:LRA={lra}:measured_I={measured['input_i']}"
        f":measured_TP={measured['input_tp']}:measured_LRA={measured['input_lra']}"
        f":measured_thresh={measured['input_thresh']}:offset={measured['target_offset']}"
        ":linear=true:print_format=json,aresample=48000"
    )


def measure_output(path: str) -> tuple[float, float]:
    """Integrated loudness (LUFS) and true peak (dBTP) of a file as delivered."""
    report = ffmpeg(
        "-nostats",
        "-i",
        path,
        "-map",
        "0:a:0",
        "-af",
        "ebur128=peak=true:framelog=quiet",
        "-f",
        "null",
        "-",
    )
    summary = report[report.rfind("Summary:") :]
    integrated = float(re.search(r"I:\s+(-?[\d.]+|-inf) LUFS", summary).group(1))
    peak = float(re.search(r"True peak:\s+Peak:\s+(-?[\d.]+|-inf) dBFS", summary).group(1))
    return integrated, peak


def codec_args(out: Path, has_video: bool) -> list[str]:
    if has_video and out.suffix.lower() in {".mp4", ".mov", ".m4v", ".mkv"}:
        return ["-map", "0:v:0", "-c:v", "copy", "-map", "0:a:0", *AAC, *FASTSTART]
    if out.suffix.lower() == ".wav":
        return ["-map", "0:a:0", "-c:a", "pcm_s16le"]
    if out.suffix.lower() == ".mp3":
        return ["-map", "0:a:0", "-c:a", "libmp3lame", "-b:a", "192k"]
    return ["-map", "0:a:0", *AAC]


def add_parser(sub) -> None:
    p = sub.add_parser("loudness", help="-14 LUFS / -1.5 dBTP, verified after encoding")
    p.add_argument("input")
    p.add_argument("-o", "--output", help="default <input>.loud.<ext>")
    p.add_argument("--target", type=float, default=-14.0, help="integrated loudness, LUFS (-14)")
    p.add_argument(
        "--tp", type=float, default=-1.5, help="true-peak target before encoding, dBTP (-1.5)"
    )
    p.add_argument(
        "--ceiling", type=float, default=-1.0, help="max true peak after encoding, dBTP (-1.0)"
    )
    p.set_defaults(func=main)


def main(args) -> None:
    timer = Timer()
    source = Path(args.input)
    out = Path(args.output or source.with_name(f"{source.stem}.loud{source.suffix}"))
    out.parent.mkdir(parents=True, exist_ok=True)
    info = probe(source)
    if not info.has_audio:
        raise SystemExit("no audio track")
    before = loudnorm_measure(str(source), args.target, args.tp)
    limited = needs_limiter(before, args.target, args.tp)
    gain = args.target - float(before["input_i"])
    # The limited path starts LIMITER_HEADROOM_DB lower (AAC put back about 1 dB over the
    # limiter) and moves its gain too, as limiting takes away some loudness.
    attempts, tp = [], args.tp - (LIMITER_HEADROOM_DB if limited else 0.0)
    for _ in range(MAX_ATTEMPTS * 2 if limited else MAX_ATTEMPTS):
        if limited:
            audio_filter = limiter_filter(gain, tp)
        else:
            audio_filter = apply_filter(before, args.target, tp)
        ffmpeg("-i", str(source), "-af", audio_filter, *codec_args(out, info.has_video), str(out))
        integrated, peak = measure_output(str(out))
        attempts.append({"tp_target": round(tp, 2), "lufs": integrated, "true_peak": peak})
        loud_ok = not limited or abs(integrated - args.target) <= 0.5
        if peak <= args.ceiling and loud_ok:
            break
        if peak > args.ceiling:
            tp -= STEP_DB
        if not loud_ok:
            gain += args.target - integrated
    ok = peak <= args.ceiling and abs(integrated - args.target) <= 1.0
    emit(
        {
            "output": str(out),
            "input_lufs": float(before["input_i"]),
            "input_true_peak": float(before["input_tp"]),
            "lufs": integrated,
            "true_peak": peak,
            "attempts": attempts,
            "limited": limited,
            "pass": ok,
            "seconds": timer.seconds(),
        }
    )
    if not ok:
        raise SystemExit(f"loudness check failed: {integrated} LUFS, {peak} dBTP after encoding")
