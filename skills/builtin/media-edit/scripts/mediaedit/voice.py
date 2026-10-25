"""media-edit voice: clean up speech (high-pass, rnnoise denoise, EQ, de-ess, compressor, limiter).

The chain delays the audio slightly (arnndn by about 10 ms); the delay is measured by
cross-correlation against the original and removed, so lips stay in sync. Video is copied.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from .common import AAC, FASTSTART, MODELS, Timer, emit, ffmpeg, probe, read_audio

RATE = 48000
VIDEO_SUFFIXES = {".mp4", ".mov", ".m4v", ".mkv"}


def chain(denoise: bool = True, deess: bool = True) -> str:
    filters = ["highpass=f=80"]
    if denoise:
        filters.append(f"arnndn=m={MODELS / 'rnnoise-sh.rnnn'}")
    filters += [
        "equalizer=f=250:t=q:w=1:g=-2",  # less mud
        "equalizer=f=3500:t=q:w=1.2:g=2.5",  # presence
    ]
    if deess:
        filters.append("deesser=i=0.4:f=0.5")
    filters += [
        "acompressor=threshold=-20dB:ratio=3:attack=8:release=120:makeup=3dB",
        "alimiter=limit=0.89:level=false",
    ]
    return ",".join(filters)


def measure_lag(original, processed, rate: int, max_ms: float = 100.0) -> int:
    """Samples by which `processed` lags `original` (positive = late), from cross-correlation."""
    import numpy as np
    from scipy.signal import correlate

    n = min(len(original), len(processed), rate * 30)
    a, b = original[:n], processed[:n]
    corr = correlate(b, a, mode="full", method="fft")
    lags = np.arange(-n + 1, n)
    window = np.abs(lags) <= rate * max_ms / 1000
    return int(lags[window][np.argmax(corr[window])])


def loudness_stats(path: str) -> dict:
    report = ffmpeg("-nostats", "-i", path, "-af", "ebur128=framelog=quiet", "-f", "null", "-")
    summary = report[report.rfind("Summary:") :]
    stats = {}
    for key, label in (("I", "I:"), ("LRA", "LRA:")):
        line = next((part for part in summary.splitlines() if part.strip().startswith(label)), "")
        stats[key] = float(line.split()[1]) if line else None
    return stats


def audio_codec(path: Path) -> list[str]:
    suffix = path.suffix.lower()
    if suffix == ".wav":
        return ["-c:a", "pcm_s16le"]
    if suffix == ".mp3":
        return ["-c:a", "libmp3lame", "-b:a", "192k"]
    return AAC


def add_parser(sub) -> None:
    p = sub.add_parser("voice", help="speech enhancement with sync-safe delay compensation")
    p.add_argument("input", help="video or audio")
    p.add_argument("-o", "--output", help="default <input>.voice.<ext> (.wav stays wav)")
    p.add_argument(
        "--no-denoise", action="store_true", help="skip arnndn (already clean studio audio)"
    )
    p.add_argument("--no-deess", action="store_true")
    p.set_defaults(func=main)


def main(args) -> None:
    timer = Timer()
    source = Path(args.input)
    out = Path(args.output or source.with_name(f"{source.stem}.voice{source.suffix}"))
    out.parent.mkdir(parents=True, exist_ok=True)
    info = probe(source)
    if not info.has_audio:
        raise SystemExit("no audio track")
    with tempfile.TemporaryDirectory() as tmp:
        raw, processed = f"{tmp}/raw.wav", f"{tmp}/processed.wav"
        ffmpeg("-i", str(source), "-map", "0:a:0", "-ar", str(RATE), "-c:a", "pcm_s16le", raw)
        ffmpeg(
            "-i",
            raw,
            "-af",
            chain(not args.no_denoise, not args.no_deess),
            "-ar",
            str(RATE),
            "-c:a",
            "pcm_s16le",
            processed,
        )
        lag = measure_lag(read_audio(raw, RATE), read_audio(processed, RATE), RATE)
        # Shift back by the measured lag and keep the original length.
        aligned = f"{tmp}/aligned.wav"
        shift = (
            f"atrim=start_sample={lag},asetpts=PTS-STARTPTS" if lag > 0 else f"adelay={-lag}S:all=1"
        )
        ffmpeg(
            "-i",
            processed,
            "-af",
            f"{shift},apad",
            "-t",
            f"{info.duration:.4f}",
            "-c:a",
            "pcm_s16le",
            aligned,
        )
        before, after = loudness_stats(raw), loudness_stats(aligned)
        if info.has_video and out.suffix.lower() in VIDEO_SUFFIXES:
            ffmpeg(
                "-i",
                str(source),
                "-i",
                aligned,
                "-map",
                "0:v:0",
                "-map",
                "1:a",
                "-c:v",
                "copy",
                *AAC,
                *FASTSTART,
                "-shortest",
                str(out),
            )
        else:
            ffmpeg("-i", aligned, *audio_codec(out), str(out))
    emit(
        {
            "output": str(out),
            "delay_compensated_ms": round(1000 * lag / RATE, 2),
            "loudness_before": before,
            "loudness_after": after,
            "seconds": timer.seconds(),
        }
    )
