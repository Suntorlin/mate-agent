#!/usr/bin/env python3
"""Turn one finished ad into a matrix of hook x headline x size variants.

  variants.py wrap   <video.mp4> <project>      a finished MP4 -> <project>/timeline.json (one shot, own sound)
  variants.py build  <project>                  variants.json + timeline.json -> variants/<name>/timeline.json
  variants.py render <project> [--only <text>]  render + loudness for each, then a hook contact sheet
  variants.py sheet  <project>                  rebuild variants/sheet.jpg from the rendered files

variants.json:
  {"prefix": "acme",                     file name prefix
   "base": "timeline.json",
   "hook_seconds": 2.0,                  where the base hook ends (default: end of the first shot)
   "hooks": [{"id": "h0"},               h0 with no fields = the base hook, unchanged
             {"id": "h1", "text": "Stop scrolling", "src": "assets/hook_h1.mp4",
              "vo": "assets/hook_h1.mp3", "line": "caption for the new voice line", "duration": 2.4}],
   "headlines": [{"id": "t0"}, {"id": "t1", "replace": {"old on-screen text": "new text"}}],
   "sizes": ["9:16", "4:5", "1:1", "16:9"],
   "sources": {"16:9": {"assets/s02.mp4": "assets/s02_wide.mp4"}},   per-size replacements for shots that crop badly
   "combos": [["h1", "t0", "9:16"]],     optional: exactly these instead of the full matrix
   "limit": 12}
"""
import json, os, re, shutil, subprocess, sys
from pathlib import Path

SIZES = {"9:16": (1080, 1920), "4:5": (1080, 1350), "1:1": (1080, 1080), "16:9": (1920, 1080)}
CJK = re.compile(r"[぀-ヿ㐀-鿿가-힯]")


def die(msg):
    print("ERROR " + msg, file=sys.stderr)
    sys.exit(2)


def probe(path, entries="format=duration"):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", entries, "-of", "csv=p=0", str(path)],
                         capture_output=True, text=True).stdout.strip()
    return out


def seconds(path):
    try:
        return float(probe(path).splitlines()[0])
    except Exception:
        return None


def cmd_wrap(args):
    if len(args) < 2:
        die("usage: variants.py wrap <video.mp4> <project>")
    video, root = Path(args[0]).resolve(), Path(args[1]).resolve()
    (root / "assets").mkdir(parents=True, exist_ok=True)
    dst = root / "assets" / ("base" + video.suffix.lower())
    if video != dst:
        shutil.copy2(video, dst)
    w, h = (int(x) for x in probe(dst, "stream=width,height").split(",")[:2])
    dur = seconds(dst)
    tl = {"canvas": {"width": w, "height": h, "fps": 30}, "shots": [{"src": f"assets/{dst.name}", "duration": round(dur, 3), "volume": 1}]}
    (root / "timeline.json").write_text(json.dumps(tl, indent=1))
    print(f"wrapped {dst.name}: {w}x{h} {dur:.2f} s -> {root / 'timeline.json'}")
    print("note: text burned into the picture cannot be replaced; only add a new hook clip, voice line or size")


def place(shots):
    cursor, out = 0.0, []
    for s in shots:
        start = s.get("start", cursor)
        cursor = start + s["duration"]
        out.append((start, cursor, s))
    return out


def caption_words(text, start, dur):
    units = re.findall(r"[A-Za-z0-9']+|[^\sA-Za-z0-9']", text) if CJK.search(text) else text.split()
    merged = []
    for u in units:
        if merged and not re.match(r"\w", u, re.UNICODE):
            merged[-1] += u
        else:
            merged.append(u)
    total, t, words = sum(max(1, len(u)) for u in merged) or 1, start, []
    for u in merged:
        d = dur * max(1, len(u)) / total
        words.append({"text": u, "start": round(t, 3), "end": round(t + d, 3)})
        t += d
    return words


def swap_hook(root, tl, hook, hook_seconds):
    if not any(k in hook for k in ("text", "src", "vo", "duration")):
        return tl, []
    notes = []
    placed = place(tl["shots"])
    H = hook_seconds or placed[0][1]
    vo_dur = seconds(root / hook["vo"]) if hook.get("vo") else None
    if hook.get("vo") and vo_dur is None:
        die(f"hook {hook['id']}: cannot read {hook['vo']}")
    d = hook.get("duration") or (round(vo_dur + 0.3, 2) if vo_dur else H)
    delta = d - H
    first = placed[0][2]
    new_first = {k: v for k, v in first.items() if k not in ("start", "transition")}
    if hook.get("src"):
        new_first = {"src": hook["src"], "duration": d}
        if hook.get("volume") is not None:
            new_first["volume"] = hook["volume"]
    else:
        have = seconds(root / first["src"]) if first["src"].lower().endswith((".mp4", ".mov", ".webm", ".m4v", ".mkv")) else None
        if have and have + 0.04 < first.get("trimStart", 0) + d:
            notes.append(f"hook {hook['id']}: the base hook clip is {have:.2f} s but the new hook lasts {d:.2f} s; give it a src")
    new_first["duration"] = d
    shots = [new_first]
    for start, end, s in placed:
        if end <= H + 1e-6:
            continue
        s = dict(s)
        if start < H:                                   # straddles the hook end: keep the part after it
            cut = H - start
            s["duration"] = round(s["duration"] - cut, 3)
            if s["src"].lower().endswith((".mp4", ".mov", ".webm", ".m4v", ".mkv")):
                s["trimStart"] = round(s.get("trimStart", 0) + cut, 3)
            s.pop("start", None)
            s.pop("transition", None)
        elif "start" in s:
            s["start"] = round(s["start"] + delta, 3)
        shots.append(s)
    texts = []
    for x in tl.get("texts", []):
        if x["start"] < H - 1e-6:
            if x.get("style") != "hook":
                notes.append(f"hook {hook['id']}: dropped on-screen text {x['text']!r} that sat inside the old hook")
            continue
        texts.append({**x, "start": round(x["start"] + delta, 3)})
    if hook.get("text"):
        texts.insert(0, {"text": hook["text"], "start": 0, "duration": min(d, hook.get("text_seconds", 2.5)), "style": "hook",
                         "position": hook.get("position", "upper")})
    captions = []
    for c in tl.get("captions", []):
        if c["words"][0]["start"] < H - 1e-6:
            continue
        c = dict(c)
        c["words"] = [{**w, "start": round(w["start"] + delta, 3), "end": round(w["end"] + delta, 3)} for w in c["words"]]
        for k in ("start", "end"):
            if k in c:
                c[k] = round(c[k] + delta, 3)
        captions.append(c)
    audio = []
    for a in tl.get("audio", []):
        start = a.get("start", 0)
        if start >= H - 1e-6:
            audio.append({**a, "start": round(start + delta, 3)})
            continue
        length = a.get("duration") or ((seconds(root / a["src"]) or 1e9) - a.get("trimStart", 0))
        if start + length <= H + 0.35:
            if hook.get("vo"):
                continue                                # the old hook's voice line
            audio.append(a)
        else:
            audio.append(a)                             # a bed that runs through the video (music)
    if hook.get("vo"):
        audio.insert(0, {"src": hook["vo"], "start": 0})
        if hook.get("line"):
            captions.insert(0, {"words": caption_words(hook["line"], 0.0, vo_dur), "position": "lower"})
    return {**tl, "shots": shots, "texts": texts, "captions": captions, "audio": audio}, notes


def swap_headline(tl, headline):
    replace = headline.get("replace") or {}
    if not replace:
        return tl
    texts = [dict(x) for x in tl.get("texts", [])]
    for old, new in replace.items():
        hits = [x for x in texts if old in x["text"]]
        if not hits:
            die(f"headline {headline['id']}: no on-screen text contains {old!r} (texts: {[x['text'] for x in texts]})")
        for x in hits:
            x["text"] = x["text"].replace(old, new)
    return {**tl, "texts": texts}


def resize(root, tl, size, sources):
    if size not in SIZES:
        die(f"unknown size {size!r}; use one of {list(SIZES)}")
    w, h = SIZES[size]
    notes, shots = [], []
    swap = (sources or {}).get(size, {})
    for s in tl["shots"]:
        s = dict(s)
        if s["src"] in swap:
            s["src"] = swap[s["src"]]
        dims = probe(root / s["src"], "stream=width,height").split(",")
        if len(dims) >= 2 and dims[0].isdigit():
            sw, sh = int(dims[0]), int(dims[1])
            scale = max(w / sw, h / sh)
            kept = (w / scale) * (h / scale) / (sw * sh)
            if kept < 0.6 and s.get("fit", "cover") == "cover":
                notes.append((kept, s["src"]))
        shots.append(s)
    if notes:
        worst = min(notes)
        notes = [f"{size}: {len(notes)} of {len(shots)} shots lose over 40% of their picture to the crop (worst: {worst[1]} keeps "
                 f"{worst[0]:.0%}); look at the sheet, or give wider sources under sources[{size!r}]"]
    return {**tl, "canvas": {**tl.get("canvas", {}), "width": w, "height": h}, "shots": shots}, notes


def relink(tl, depth="../../"):
    def fix(src):
        return src if re.match(r"^(https?://|/)", src) else depth + src
    out = json.loads(json.dumps(tl))
    for key in ("shots", "audio"):
        for item in out.get(key, []):
            item["src"] = fix(item["src"])
    return out


def cmd_build(args):
    root = Path(args[0]).resolve()
    cfg_path = root / "variants.json"
    if not cfg_path.exists():
        die(f"{cfg_path} not found")
    cfg = json.loads(cfg_path.read_text())
    base = json.loads((root / cfg.get("base", "timeline.json")).read_text())
    hooks = {h["id"]: h for h in cfg.get("hooks") or [{"id": "h0"}]}
    heads = {t["id"]: t for t in cfg.get("headlines") or [{"id": "t0"}]}
    sizes = cfg.get("sizes") or ["9:16"]
    combos = cfg.get("combos") or [[h, t, s] for h in hooks for t in heads for s in sizes]
    limit = cfg.get("limit", 12)
    if len(combos) > limit:
        die(f"{len(combos)} variants exceed limit {limit}: list the ones worth testing in \"combos\" or raise \"limit\"")
    out_dir = root / "variants"
    out_dir.mkdir(exist_ok=True)
    manifest, all_notes = [], []
    for h, t, s in combos:
        if h not in hooks or t not in heads:
            die(f"combo {[h, t, s]} names an unknown hook or headline")
        tl, n1 = swap_hook(root, base, hooks[h], cfg.get("hook_seconds"))
        tl = swap_headline(tl, heads[t])
        tl, n2 = resize(root, tl, s, cfg.get("sources"))
        name = "_".join(x for x in (cfg.get("prefix"), h, t, s.replace(":", "x")) if x)
        (out_dir / name).mkdir(exist_ok=True)
        (out_dir / name / "timeline.json").write_text(json.dumps(relink(tl), ensure_ascii=False, indent=1))
        total = max(e for _s, e, _x in place(tl["shots"]))
        manifest.append({"name": name, "hook": h, "headline": t, "size": s, "seconds": round(total, 2),
                         "timeline": f"variants/{name}/timeline.json", "file": f"variants/{name}.mp4"})
        all_notes += [x for x in n1 + n2 if x not in all_notes]
        print(f"{name:<32} {total:6.2f} s")
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    for n in all_notes:
        print("warning: " + n)
    print(f"{len(manifest)} variants -> {out_dir}/manifest.json")


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def cmd_render(args):
    root = Path(args[0]).resolve()
    only = args[args.index("--only") + 1] if "--only" in args else ""
    mp = root / "variants" / "manifest.json"
    if not mp.exists():
        die("run build first")
    manifest = json.loads(mp.read_text())
    render = os.environ.get("RENDER_COMMAND", "render")
    failed = 0
    for m in manifest:
        if only and only not in m["name"]:
            continue
        raw = root / "variants" / (m["name"] + ".raw.mp4")
        final = root / m["file"]
        r = run([render, str(root / m["timeline"]), str(raw)])       # one renderer at a time
        if r.returncode or not raw.exists():
            m["status"] = "render failed"
            failed += 1
            print(f"FAIL {m['name']}: {(r.stderr or r.stdout).strip().splitlines()[-1] if (r.stderr or r.stdout).strip() else r.returncode}")
            continue
        if shutil.which("media-edit"):
            r = run(["media-edit", "loudness", str(raw), "-o", str(final)])
            m["loudness"] = "pass" if r.returncode == 0 else "check"
        else:
            r = run(["ffmpeg", "-v", "error", "-y", "-i", str(raw), "-c:v", "copy", "-af", "loudnorm=I=-14:TP=-1.5:LRA=11",
                     "-c:a", "aac", "-b:a", "192k", str(final)])
            m["loudness"] = "single pass (no media-edit)"
        if final.exists():
            raw.unlink()
            m["status"], m["seconds"] = "ok", round(seconds(final) or 0, 2)
            print(f"ok   {m['name']}  {m['seconds']} s  loudness {m['loudness']}")
        else:
            m["status"] = "loudness failed"
            failed += 1
            print(f"FAIL {m['name']}: loudness step")
    mp.write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    cmd_sheet([str(root)])
    if failed:
        sys.exit(1)


def cmd_sheet(args):
    root = Path(args[0]).resolve()
    manifest = json.loads((root / "variants" / "manifest.json").read_text())
    done = [m for m in manifest if (root / m["file"]).exists()]
    if not done:
        print("no rendered variants yet")
        return
    tmp = root / "variants" / "_sheet"
    tmp.mkdir(exist_ok=True)
    cells = []
    for i, m in enumerate(done):
        cell = tmp / f"{i:02d}.jpg"
        vf = "scale=360:360:force_original_aspect_ratio=decrease,pad=360:400:(ow-iw)/2:0:color=0x15161a"
        run(["ffmpeg", "-v", "error", "-y", "-ss", "0.8", "-i", str(root / m["file"]), "-frames:v", "1", "-vf", vf, str(cell)])
        try:
            from PIL import Image, ImageDraw
            img = Image.open(cell)
            ImageDraw.Draw(img).text((8, 372), m["name"], fill=(235, 235, 235))
            img.save(cell)
        except Exception:
            pass
        cells.append(cell)
    cols = min(4, len(cells))
    rows = -(-len(cells) // cols)
    sheet = root / "variants" / "sheet.jpg"
    run(["ffmpeg", "-v", "error", "-y", "-pattern_type", "glob", "-i", str(tmp / "*.jpg"), "-vf", f"tile={cols}x{rows}", "-frames:v", "1", str(sheet)])
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"sheet -> {sheet} ({len(done)} hooks at 0.8 s, in manifest order)")


if __name__ == "__main__":
    cmds = {"wrap": cmd_wrap, "build": cmd_build, "render": cmd_render, "sheet": cmd_sheet}
    if len(sys.argv) < 3 or sys.argv[1] not in cmds:
        print(__doc__)
        sys.exit(64)
    cmds[sys.argv[1]](sys.argv[2:])
