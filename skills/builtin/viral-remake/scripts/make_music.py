#!/usr/bin/env python3
"""Synthesize an original 100 BPM city-pop groove + UI sound effects (numpy/scipy only, no network).

Without a music generation tool, this gives every edit an original, license-free bed.
Align the sections to your edit timeline (seconds, each value = section start):

  python3 make_music.py --out-dir /workspace/project/assets/audio --duration 57 \
      --sections intro=0,groove=4,build=29,drop=39.6,adbreak=43.6,outro=48 --impacts 4,39.6,51

Sections: intro (pads + riser), groove (drums/bass/e-piano; arps after --arps-from), build (16th hats,
riser before the drop), drop (big half-time hits), adbreak (soft, sits under a voiceover), outro.
Writes music.wav and sfx_{whoosh,pop,key,ding,notify}.wav.
"""
import argparse
import os
import numpy as np
from scipy.signal import butter, sosfilt, fftconvolve
from scipy.io import wavfile

SR = 44100
BPM = 100
BEAT = 60 / BPM
BAR = 4 * BEAT
DUR = 57.0
OUT = "."
SECTIONS = [("intro", 0.0), ("groove", 4.0), ("build", 29.0), ("drop", 39.6), ("adbreak", 43.6), ("outro", 48.0)]
IMPACTS = [4.0, 39.6, 51.0]
ARPS_FROM = 15.0
rng = np.random.default_rng(7)


def t_(d):
    return np.arange(int(d * SR)) / SR


def lp(x, f, order=2):
    return sosfilt(butter(order, f, "low", fs=SR, output="sos"), x)


def hp(x, f, order=2):
    return sosfilt(butter(order, f, "high", fs=SR, output="sos"), x)


def bp(x, lo, hi, order=2):
    return sosfilt(butter(order, [lo, hi], "band", fs=SR, output="sos"), x)


def env(n, a=0.005, d=0.2, s=0.0, r=0.05, hold=None):
    t = np.arange(n) / SR
    e = np.minimum(1, t / max(a, 1e-4))
    dec = s + (1 - s) * np.exp(-(t - a).clip(0) / max(d, 1e-4))
    e = np.where(t < a, e, dec)
    if hold is not None:
        rel = np.exp(-(t - hold).clip(0) / max(r, 1e-4))
        e = e * np.where(t < hold, 1, rel)
    return e


def midi(n):
    return 440 * 2 ** ((n - 69) / 12)


def place(buf, x, at, gain=1.0):
    i = int(at * SR)
    if i >= len(buf):
        return
    x = x[: len(buf) - i]
    buf[i:i + len(x)] += gain * (x if x.ndim == buf.ndim else np.stack([x, x], 1))


# ---- instruments -----------------------------------------------------------
def kick():
    t = t_(0.45)
    f = 48 + 110 * np.exp(-t / 0.045)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.23)
    x[:200] += rng.standard_normal(200) * 0.3 * np.linspace(1, 0, 200)
    return np.tanh(1.6 * x)


def snare():
    t = t_(0.3)
    n = bp(rng.standard_normal(len(t)), 1200, 7000) * np.exp(-t / 0.12)
    tone = np.sin(2 * np.pi * 190 * t) * np.exp(-t / 0.07)
    return 0.8 * n + 0.5 * tone


def clap():
    t = t_(0.35)
    x = np.zeros(len(t))
    for k in range(3):
        s = int(k * 0.011 * SR)
        x[s:] += bp(rng.standard_normal(len(t) - s), 900, 5000) * np.exp(-np.arange(len(t) - s) / SR / 0.02)
    x += bp(rng.standard_normal(len(t)), 900, 5000) * np.exp(-t / 0.15) * 0.5
    return x * 0.7


def hat(open_=False):
    t = t_(0.35 if open_ else 0.06)
    return hp(rng.standard_normal(len(t)), 7000) * np.exp(-t / (0.12 if open_ else 0.018)) * 0.35


def bass_note(n, d):
    t = t_(d)
    f = midi(n)
    x = np.sin(2 * np.pi * f * t) + 0.35 * np.sign(np.sin(2 * np.pi * f * t))
    return lp(np.tanh(1.2 * x), 700) * env(len(t), 0.004, 0.35, 0.55, 0.04, hold=d * 0.85) * 0.55


def epiano(n, d):
    t = t_(d + 0.6)
    f = midi(n)
    mod = np.sin(2 * np.pi * f * t) * (2.2 * np.exp(-t / 0.25))
    x = np.sin(2 * np.pi * f * t + mod) + 0.2 * np.sin(2 * np.pi * 2 * f * t) * np.exp(-t / 0.1)
    return x * env(len(t), 0.003, 0.9, 0.25, 0.3, hold=d) * 0.16


def pad(notes, d):
    t = t_(d)
    x = np.zeros(len(t))
    for n in notes:
        for det in (-0.08, 0, 0.08):
            f = midi(n + det)
            x += 2 * ((f * t) % 1) - 1
    x = lp(x / (len(notes) * 3), 1400, 2)
    a = np.minimum(1, t / 0.6) * np.minimum(1, (d - t) / 0.5).clip(0)
    return x * a * 0.22


def pluck(n, d=0.35):
    t = t_(d)
    f = midi(n)
    x = 2 * ((f * t) % 1) - 1
    cut = 600 + 5000 * np.exp(-t / 0.05)
    y = lp(x, 3500) * np.exp(-t / 0.16)
    return y * 0.14 * (cut / cut.max())


def riser(d):
    t = t_(d)
    n = rng.standard_normal(len(t))
    out = np.zeros(len(t))
    seg = int(0.05 * SR)
    for i in range(0, len(t), seg):
        k = i / len(t)
        lo = 300 + 6000 * k
        out[i:i + seg] = bp(n[i:i + seg], lo, min(lo * 1.8, 18000))
    sweep = np.sin(2 * np.pi * np.cumsum(200 + 900 * (t / d) ** 2) / SR) * 0.25
    return (out * 0.5 + sweep) * (t / d) ** 2


def impact():
    t = t_(2.5)
    boom = np.sin(2 * np.pi * np.cumsum(38 + 60 * np.exp(-t / 0.08)) / SR) * np.exp(-t / 0.7)
    noise = lp(rng.standard_normal(len(t)), 3000) * np.exp(-t / 0.3) * 0.4
    return np.tanh(1.5 * (boom + noise)) * 0.9


def reverb(x, secs=2.2, mix=0.22):
    t = t_(secs)
    ir = rng.standard_normal((len(t), 2)) * np.exp(-t / (secs / 5))[:, None]
    ir = np.stack([lp(ir[:, 0], 6000), lp(ir[:, 1], 6000)], 1)
    wet = np.stack([fftconvolve(x[:, c], ir[:, c])[: len(x)] for c in range(2)], 1)
    wet /= np.abs(wet).max() + 1e-9
    return x + mix * wet * np.abs(x).max()


# ---- arrangement -----------------------------------------------------------
PROG = [[53, 57, 60, 64], [52, 55, 59, 62], [57, 60, 64, 67], [50, 53, 57, 60]]  # Fmaj7 Em7 Am7 Dm7
ROOTS = [41, 40, 45, 38]
ARP = [[65, 69, 72, 76], [64, 67, 71, 74], [69, 72, 76, 79], [62, 65, 69, 72]]


def build():
    n = int(DUR * SR)
    drums, music, fx = (np.zeros((n, 2)) for _ in range(3))
    bars = int(DUR / BAR) + 1
    for b in range(bars):
        t0 = b * BAR
        ch = b % 4
        sect = [name for name, start in SECTIONS if start <= t0 + 1e-6][-1]
        place(music, pad(PROG[ch], BAR + 0.1), t0, 1.0 if sect in ("intro", "adbreak") else 0.6)
        if sect == "intro":
            continue
        if sect != "adbreak":
            for k, (step, d) in enumerate([(0, 0.9), (1.5, 0.4), (2, 0.9), (3.5, 0.4)]):
                note = ROOTS[ch] + (12 if k == 1 else 7 if k == 3 else 0)
                place(music, bass_note(note, d * BEAT), t0 + step * BEAT)
            for step in (0, 1.5, 2.5):
                for nn in PROG[ch]:
                    place(music, epiano(nn + 12, 0.35 * BEAT), t0 + step * BEAT)
        if sect in ("groove", "build", "outro"):
            for beat in range(4):
                if beat in (0, 2):
                    place(drums, kick(), t0 + beat * BEAT)
                if beat == 2:
                    place(drums, kick(), t0 + (beat + 0.75) * BEAT, 0.6)
                if beat in (1, 3):
                    place(drums, snare(), t0 + beat * BEAT, 0.7)
                    place(drums, clap(), t0 + beat * BEAT, 0.5)
                subdiv = 4 if sect == "build" else 2
                for s in range(subdiv):
                    place(drums, hat(open_=(s == subdiv - 1 and beat == 3)), t0 + (beat + s / subdiv) * BEAT, 0.8)
        if sect in ("groove", "build") and t0 >= ARPS_FROM:
            for s in range(8):
                place(music, pluck(ARP[ch][s % 4] + (12 if s >= 4 else 0)), t0 + s * BEAT / 2)
        if sect == "drop":
            place(drums, kick(), t0, 1.2)
            place(drums, kick(), t0 + 2 * BEAT, 1.0)
            place(drums, snare(), t0 + 3 * BEAT, 0.9)
        if sect == "adbreak":
            for s in range(4):
                place(music, epiano(PROG[ch][s] + 24, BEAT), t0 + s * BEAT, 0.8)
    for i, at in enumerate(IMPACTS):
        place(fx, riser(min(3.5, at)), max(0.0, at - min(3.5, at)), 0.5)
        place(fx, impact(), at, 0.7 if i == 0 else 0.9)
    mix = reverb(music, mix=0.25) * 0.9 + drums * 0.85 + fx
    # gentle sidechain pump on music from the four-on-the-floor grid
    t = np.arange(n) / SR
    pump = 1 - 0.25 * np.exp(-((t - 4) % BEAT) / 0.12) * (t > 4)
    mix = mix * pump[:, None]
    fade = np.minimum(1, (DUR - t) / 3.0).clip(0)
    mix *= fade[:, None]
    mix = np.tanh(1.1 * mix / (np.abs(mix).max() + 1e-9)) * 0.89
    return mix


def sfx():
    out = {}
    t = t_(0.5)
    out["whoosh"] = np.stack([bp(rng.standard_normal(len(t)), 400, 5000) * np.sin(np.pi * t / 0.5) ** 2] * 2, 1) * 0.6
    t = t_(0.18)
    out["pop"] = np.stack([np.sin(2 * np.pi * np.cumsum(500 + 900 * t / 0.18) / SR) * np.exp(-t / 0.05)] * 2, 1) * 0.5
    t = t_(0.03)
    out["key"] = np.stack([hp(rng.standard_normal(len(t)), 2500) * np.exp(-t / 0.006)] * 2, 1) * 0.5
    t = t_(0.9)
    ding = sum(np.sin(2 * np.pi * f * t + 1.5 * np.sin(2 * np.pi * f * 3.5 * t) * np.exp(-t / 0.1)) * np.exp(-t / 0.35)
               for f in (midi(84), midi(91)))
    out["ding"] = np.stack([ding * 0.25] * 2, 1)
    t = t_(0.6)
    chime = np.concatenate([np.sin(2 * np.pi * midi(79) * t_(0.15)) * np.exp(-t_(0.15) / 0.08),
                            np.sin(2 * np.pi * midi(84) * t) * np.exp(-t / 0.2)])
    out["notify"] = np.stack([chime * 0.3] * 2, 1)
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out-dir", default=".")
    ap.add_argument("--duration", type=float, default=DUR)
    ap.add_argument("--sections", default=",".join(f"{n}={t}" for n, t in SECTIONS))
    ap.add_argument("--impacts", default=",".join(str(t) for t in IMPACTS))
    ap.add_argument("--arps-from", type=float, default=ARPS_FROM)
    a = ap.parse_args()
    OUT, DUR, ARPS_FROM = a.out_dir, a.duration, a.arps_from
    SECTIONS = sorted(((kv.split("=")[0], float(kv.split("=")[1])) for kv in a.sections.split(",")), key=lambda x: x[1])
    IMPACTS = [float(x) for x in a.impacts.split(",") if x]
    os.makedirs(OUT, exist_ok=True)
    wavfile.write(os.path.join(OUT, "music.wav"), SR, (build() * 32767).astype(np.int16))
    for k, v in sfx().items():
        wavfile.write(os.path.join(OUT, f"sfx_{k}.wav"), SR, (np.clip(v, -1, 1) * 32767).astype(np.int16))
    print("ok")
