#!/usr/bin/env python3
"""Build the soundtrack of a long-scroll film from out/timeline.json and audio/score.json.

  python3 mix.py <project>   →  <project>/out/mix.wav (−14 LUFS)

score.json (all optional):
  {"worlds": {"<seg id>": {"bpm": 120, "loop_beats": 8,
                          "tracks": [{"wave": "sq|tri|saw|sin", "vol": 0.2, "duty": 0.5, "notes": "72:0.5 r:0.5 76:1"}]}},
   "sfx": [{"at": "<cue id>", "offset": 0.0, "kind": "jingle", "notes": "84:0.25 88:1", "bpm": 200, "wave": "sq", "vol": 0.2},
           {"at": "<cue id>", "offset": 0.5, "kind": "sweep", "f0": 400, "f1": 900, "dur": 0.18, "vol": 0.2},
           {"at": "<cue id>", "offset": 0.0, "kind": "noise", "dur": 0.3, "vol": 0.3}],
   "blips": {"<line id>": {"chars": 18, "hz": 1800}}}
notes: MIDI number or r (rest), colon, length in beats. Write original melodies: a signature jingle
should evoke an era, not quote a copyrighted tune, unless the user owns the rights.
Voices: audio/voice/<line id>.(wav|mp3); music ducks to 40 % under them.
"""
import json, subprocess, sys, tempfile
from pathlib import Path
import numpy as np
from scipy.io import wavfile

SR = 48000
root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
tl = json.loads((root / "out/timeline.json").read_text())
sp = root / "audio/score.json"
score = json.loads(sp.read_text()) if sp.exists() else {}
N = int((tl["total"] + 0.5) * SR)
music, sfx, vox = np.zeros(N), np.zeros(N), np.zeros(N)
cue = {(c.get("line") or c.get("beat")): c for c in tl["cues"]}
seg = {s["id"]: s for s in tl["segs"]}

def hz(m): return 440.0 * 2 ** ((m - 69) / 12)
def osc(kind, f, d, duty=0.5, seed=0):
    t = np.arange(max(1, int(d * SR))) / SR
    if kind == "sq": return np.where((t * f) % 1 < duty, 1.0, -1.0)
    if kind == "tri": return 2 * np.abs(2 * ((t * f) % 1) - 1) - 1
    if kind == "saw": return 2 * ((t * f) % 1) - 1
    if kind == "noise": return np.random.default_rng(seed).uniform(-1, 1, len(t))
    return np.sin(2 * np.pi * f * t)
def env(x, a=0.004, r=0.05):
    n, e = len(x), np.ones(len(x)); na, nr = int(a * SR), min(int(r * SR), len(x))
    if na: e[:na] = np.linspace(0, 1, na)
    if nr: e[-nr:] *= np.linspace(1, 0, nr)
    return x * e
def put(buf, t, x, g=1.0):
    i = int(t * SR); j = min(N, i + len(x))
    if 0 <= i < N and j > i: buf[i:j] += x[: j - i] * g
def notes(s):
    out, b = [], 0.0
    for tok in s.split():
        m, d = tok.split(":"); d = float(d)
        if m != "r": out.append((b, d, int(m)))
        b += d
    return out

for sid, w in score.get("worlds", {}).items():
    if sid not in seg: continue
    t0, t1 = max(0, seg[sid]["tIn"] - 0.25), seg[sid]["tOut"] + 0.25
    b, lb, buf = 60 / w.get("bpm", 120), w.get("loop_beats", 8), np.zeros(N)
    k = 0
    while t0 + k * lb * b < t1:
        base = t0 + k * lb * b
        for tr in w.get("tracks", []):
            for bt, dl, m in notes(tr["notes"]):
                st = base + bt * b
                if st < t1: put(buf, st, env(osc(tr.get("wave", "sq"), hz(m), dl * b * 0.92, tr.get("duty", 0.5)), 0.004, min(0.06, dl * b * 0.3)), tr.get("vol", 0.2))
        k += 1
    fade, i0, i1 = int(0.25 * SR), int(t0 * SR), min(N, int(t1 * SR))
    buf[i0:i0 + fade] *= np.linspace(0, 1, len(buf[i0:i0 + fade])); buf[max(i0, i1 - fade):i1] *= np.linspace(1, 0, len(buf[max(i0, i1 - fade):i1]))
    music += buf

for e in score.get("sfx", []):
    c = cue.get(e["at"])
    if not c: continue
    t = c["T"] + e.get("offset", 0)
    if e.get("kind", "jingle") == "jingle":
        b = 60 / e.get("bpm", 160)
        for bt, dl, m in notes(e["notes"]): put(sfx, t + bt * b, env(osc(e.get("wave", "sq"), hz(m), dl * b * 0.95, e.get("duty", 0.5))), e.get("vol", 0.2))
    elif e["kind"] == "sweep":
        d = e.get("dur", 0.2); tt = np.arange(int(d * SR)) / SR; f = e["f0"] * (e["f1"] / e["f0"]) ** (tt / d)
        ph = np.cumsum(f) / SR; x = np.where(ph % 1 < 0.5, 1.0, -1.0) if e.get("wave", "sq") == "sq" else np.sin(2 * np.pi * ph)
        put(sfx, t, env(x, 0.002, 0.03), e.get("vol", 0.2))
    elif e["kind"] == "noise":
        d = e.get("dur", 0.3); put(sfx, t, env(osc("noise", 0, d, seed=int(t * 100)), 0.002, d * 0.8) * np.linspace(1, 0.1, int(d * SR)), e.get("vol", 0.3))

for lid, b in score.get("blips", {}).items():   # one blip per typed character, over 65 % of the line
    c = cue.get(lid)
    if not c: continue
    n, span = b.get("chars", 16), max(0.25, c["dur"] * 0.65)
    for i in range(n): put(sfx, c["T"] + i * span / n, env(osc("sq", b.get("hz", 1800), 0.022, 0.25), 0.001, 0.01), b.get("vol", 0.05))

with tempfile.TemporaryDirectory() as tmp:
    for c in tl["cues"]:
        if not c.get("line"): continue
        src = next((p for p in (root / "audio/voice").glob(c["line"] + ".*") if p.suffix in (".wav", ".mp3", ".m4a")), None)
        if not src: continue
        w = Path(tmp) / (c["line"] + ".wav")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-ac", "1", "-ar", str(SR), str(w)], check=True)
        _, x = wavfile.read(w); x = x.astype(np.float64); x /= (np.abs(x).max() + 1e-9); put(vox, c["T"], x * 0.8)

duck = np.ones(N)
for c in tl["cues"]:
    if c.get("line"): duck[max(0, int((c["T"] - 0.1) * SR)):min(N, int((c["T"] + c["dur"] + 0.2) * SR))] = 0.4
k = int(0.08 * SR); duck = np.convolve(duck, np.ones(k) / k, mode="same")
mix = np.tanh((music * 0.5 * duck + sfx * 0.8 + vox * 0.9) * 1.2) / np.tanh(1.2)
raw = root / "out/mix_raw.wav"
wavfile.write(raw, SR, (np.stack([mix, mix], 1) * 32767).astype(np.int16))
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(raw), "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-ar", str(SR), str(root / "out/mix.wav")], check=True)
print("mix ->", root / "out/mix.wav", f"{tl['total']:.1f}s")
