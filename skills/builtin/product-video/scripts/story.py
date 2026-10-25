#!/usr/bin/env python3
"""Voice-timed story builder: story.json -> checked lines -> verified voices -> timeline.json.

  story.py check    <project>            validate, time the voices, write tts_jobs.json
  story.py trim     <project>            cut edge silence off every audio/<line>.mp3 (keeps .raw)
  story.py verify   <project>            transcribe each clip and compare it with its line
  story.py timeline <project> [--draft]  write timeline.json + cues.json (render input)

story.json (see the skill for the full field list):
  {"title": "...", "language": "ja", "canvas": {"width": 1080, "height": 1920},
   "cast": "../series.json" | {"mika": {"voice_id": "...", "color": "#FFD54A", "own_voice": false}},
   "hook": {"text": "...", "duration": 2.0},
   "shots": [{"id": "s01", "visual": "...", "src": "assets/s01.mp4", "lipsync": false,
              "lines": [{"id": "l01", "who": "mika", "text": "spoken", "caption": "shown", "tags": "[whispering]"}],
              "texts": [{"text": "...", "style": "label", "position": "upper"}],
              "lead": 0.2, "gap": 0.25, "tail": 0.3, "duration": 2.0}],
   "end": {"text": "...", "duration": 2.5, "src": "assets/end.png"},
   "music": {"src": "assets/music.mp3", "volume": 0.18}}

The voice sets the clock: a shot lasts lead + its lines (real audio lengths) + gaps + tail.
"""
import difflib, json, re, shutil, subprocess, sys, unicodedata
from pathlib import Path

AUDIO_EXT = (".mp3", ".wav", ".m4a")
VIDEO_EXT = (".mp4", ".mov", ".m4v", ".webm", ".mkv")
CJK = re.compile(r"[぀-ヿ㐀-鿿가-힯]")
SILENT = re.compile(r"[\s\W_]+", re.UNICODE)


def die(msg):
    print("ERROR " + msg, file=sys.stderr)
    sys.exit(2)


def load(root):
    p = root / "story.json"
    if not p.exists():
        die(f"{p} not found")
    story = json.loads(p.read_text())
    cast = story.get("cast") or {}
    if isinstance(cast, str):
        cp = (root / cast).resolve()
        if not cp.exists():
            die(f"cast file {cp} not found")
        cast = json.loads(cp.read_text()).get("cast", {})
    story["cast"] = cast
    return story


def lines_of(story):
    for shot in story.get("shots", []):
        for line in shot.get("lines", []):
            yield shot, line


def spoken(line):
    return (line.get("tags", "") + line["text"]).strip()


def norm(text):
    text = re.sub(r"\[[^\]]*\]", "", text)
    return SILENT.sub("", unicodedata.normalize("NFKC", text)).lower()


def estimate_seconds(text, language):
    body = re.sub(r"\[[^\]]*\]", "", text)
    cjk = len(CJK.findall(body))
    words = len(re.findall(r"[A-Za-z0-9']+", body))
    rate = {"ja": 6.5, "zh": 4.5, "ko": 5.5}.get((language or "")[:2], 5.0)
    return round(cjk / rate + words / 2.6 + 0.2, 2)


def probe(path):
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                             capture_output=True, text=True, check=True).stdout
        return float(out.strip())
    except Exception:
        return None


def audio_of(root, line_id):
    for ext in AUDIO_EXT:
        p = root / "audio" / (line_id + ext)
        if p.exists():
            return p
    return None


def cmd_check(root, _args):
    story = load(root)
    cast, lang = story["cast"], story.get("language", "")
    errors, warns, jobs, seen, total_seconds = [], [], [], set(), 0.0
    shots = story.get("shots", [])
    if not shots:
        errors.append("no shots")
    if not story.get("hook", {}).get("text"):
        warns.append("no hook text: the first 2 s need words on screen")
    for shot in shots:
        sid = shot.get("id")
        if not sid or sid in seen:
            errors.append(f"shot id missing or repeated: {sid!r}")
        seen.add(sid)
        lines = shot.get("lines", [])
        if not lines and not shot.get("duration"):
            warns.append(f"{sid}: no lines and no duration, will last 2.0 s")
        if shot.get("lipsync") and len(lines) != 1:
            errors.append(f"{sid}: a lipsync shot holds exactly one line (its clip is generated from that audio)")
        est = 0.0
        for line in lines:
            lid, who = line.get("id"), line.get("who")
            if not lid or lid in seen:
                errors.append(f"line id missing or repeated: {lid!r}")
            seen.add(lid)
            if not line.get("text") or not norm(line["text"]):
                errors.append(f"{lid}: nothing to speak (punctuation such as …… is silent in TTS; make it a pause, not a line)")
                continue
            member = cast.get(who) or {}
            if not member.get("voice_id"):
                errors.append(f"{lid}: speaker {who!r} has no voice_id in the cast")
            secs = estimate_seconds(line["text"], lang)
            if secs > 6:
                warns.append(f"{lid}: about {secs} s, split lines over 6 s")
            est += secs
            jobs.append({"line": lid, "who": who, "voice_id": member.get("voice_id"), "text": spoken(line),
                         "out": f"audio/{lid}.mp3", "estimated_seconds": secs})
        total_seconds += shot.get("duration") or (est + shot.get("lead", 0.2) + shot.get("tail", 0.3)
                                                  + shot.get("gap", 0.25) * max(0, len(lines) - 1)) or 2.0
    total_seconds += story.get("end", {}).get("duration", 0)
    for j in jobs:
        print(f"{j['line']:>6}  {j['who'] or '?':<10} ~{j['estimated_seconds']:>4}s  {j['text']}")
    print(f"lines {len(jobs)}  shots {len(shots)}  estimated length {total_seconds:.1f} s")
    for w in warns:
        print("warning: " + w)
    for e in errors:
        print("ERROR " + e)
    if errors:
        sys.exit(1)
    (root / "tts_jobs.json").write_text(json.dumps(jobs, ensure_ascii=False, indent=1))
    print("wrote tts_jobs.json")


def cmd_trim(root, _args):
    flt = ("silenceremove=start_periods=1:start_threshold=-45dB,areverse,"
           "silenceremove=start_periods=1:start_threshold=-45dB,areverse")
    for _shot, line in lines_of(load(root)):
        src = audio_of(root, line["id"])
        if not src:
            continue
        raw = src.with_name(src.stem + ".raw" + src.suffix)
        if raw.exists():
            continue
        before = probe(src)
        shutil.move(src, raw)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(raw), "-af", flt, str(src)], check=True)
        print(f"{line['id']}: {before:.2f} s -> {probe(src):.2f} s")


def read_words(path):
    """media-edit words.json ({"segments": [{"text", "words": [{"word", "start", "end"}]}]}) -> (text, words)."""
    data = json.loads(path.read_text())
    if isinstance(data, dict) and "segments" in data:
        raw = [w for seg in data["segments"] for w in seg.get("words", [])]
        text = "".join(seg.get("text", "") for seg in data["segments"])
    else:
        raw = data.get("words", []) if isinstance(data, dict) else data
        text = data.get("text") if isinstance(data, dict) else None
    words = [{"text": (w.get("word") or w.get("text") or "").strip(), "start": w["start"], "end": w["end"]}
             for w in raw if isinstance(w, dict) and (w.get("word") or w.get("text") or "").strip() and "start" in w]
    return (text or "".join(w["text"] for w in words)).strip(), words


def transcript(root, line_id, src, language):
    wp = root / "audio" / (line_id + ".words.json")
    if not wp.exists():
        if not shutil.which("media-edit"):
            return None, None
        cmd = ["media-edit", "transcribe", str(src), "-o", str(wp)]
        if language:
            cmd += ["--lang", language[:2]]
        subprocess.run(cmd, capture_output=True, text=True)
        if not wp.exists():
            return None, None
    return read_words(wp)


def cmd_verify(root, _args):
    story = load(root)
    all_lines = [line for _s, line in lines_of(story)]
    bad = 0
    for line in all_lines:
        src = audio_of(root, line["id"])
        if not src:
            print(f"MISSING  {line['id']}: no audio/{line['id']}.mp3")
            bad += 1
            continue
        heard, _ = transcript(root, line["id"], src, story.get("language"))
        if heard is None:
            print(f"SKIPPED  {line['id']}: no transcript (run `media-edit transcribe {src} -o audio/{line['id']}.words.json`)")
            bad += 1
            continue
        got = norm(heard)
        score = difflib.SequenceMatcher(None, norm(line["text"]), got).ratio()
        other = max(((difflib.SequenceMatcher(None, norm(o["text"]), got).ratio(), o["id"]) for o in all_lines if o is not line),
                    default=(0, None))
        if other[0] > score + 0.15:
            print(f"WRONG    {line['id']}: the clip says line {other[1]} ({heard!r}); regenerate it")
            bad += 1
        elif score < 0.55:
            print(f"MISMATCH {line['id']} {score:.2f}: wanted {line['text']!r}, heard {heard!r}")
            bad += 1
        else:
            flag = "ok      " if score >= 0.8 else "listen  "
            print(f"{flag} {line['id']} {score:.2f} {probe(src):.2f} s  {heard}")
    if bad:
        print(f"{bad} clip(s) to fix before rendering")
        sys.exit(1)
    print("all clips say their own line")


def chunks(text, language):
    """Caption text -> display units (words for Latin scripts, 1-3 characters for CJK)."""
    if CJK.search(text):
        units = re.findall(r"[A-Za-z0-9']+|[^\sA-Za-z0-9']", text)
        out = []
        for u in units:
            if out and (not re.match(r"[\w]", u, re.UNICODE) or (len(out[-1]) < 2 and CJK.match(u) and CJK.match(out[-1][-1]))):
                out[-1] += u
            else:
                out.append(u)
        return out
    return text.split()


def group(words, max_len):
    """Timed words -> caption lines: break at sentence punctuation, never leave a short orphan line."""
    lines, cur, n = [], [], 0
    for w in words:
        if cur and n + len(w["text"]) > max_len:
            lines.append(cur)
            cur, n = [], 0
        cur.append(w)
        n += len(w["text"])
        if re.search(r"[。！？!?.]$", w["text"]) and n >= max_len * 0.4:
            lines.append(cur)
            cur, n = [], 0
    if cur:
        lines.append(cur)
    size = lambda line: sum(len(w["text"]) for w in line)
    for k in range(len(lines) - 1, 0, -1):          # rebalance a short tail with the line before it
        while len(lines[k - 1]) > 1 and size(lines[k]) + len(lines[k - 1][-1]["text"]) <= size(lines[k - 1]) - len(lines[k - 1][-1]["text"]) \
                and not re.search(r"[。！？!?.]$", lines[k - 1][-1]["text"]):
            lines[k].insert(0, lines[k - 1].pop())
    return lines


def even_words(units, start, dur):
    weights = [max(1, len(u)) for u in units]
    total, t, out = sum(weights), start, []
    for u, w in zip(units, weights):
        d = dur * w / total
        out.append({"text": u, "start": round(t, 3), "end": round(t + d, 3)})
        t += d
    return out


def draft_card(root, shot, canvas):
    out = root / "assets" / "_draft" / (shot["id"] + ".png")
    out.parent.mkdir(parents=True, exist_ok=True)
    w, h = canvas["width"], canvas["height"]
    try:
        from PIL import Image, ImageDraw, ImageFont
        img = Image.new("RGB", (w, h), (24, 26, 32))
        d = ImageDraw.Draw(img)
        font = None
        for f in ("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", "/System/Library/Fonts/Hiragino Sans GB.ttc",
                  "/System/Library/Fonts/PingFang.ttc"):
            if Path(f).exists():
                font = ImageFont.truetype(f, w // 22)
                break
        text = f"{shot['id']}\n" + "\n".join(re.findall(r".{1,18}", shot.get("visual", "")))
        d.multiline_text((w // 12, int(h * 0.42)), text, fill=(210, 214, 222), font=font, spacing=18)
        img.save(out)
    except Exception:
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c=0x181a20:s={w}x{h}:d=1",
                        "-frames:v", "1", str(out)], check=True)
    return str(out.relative_to(root))


def cmd_timeline(root, args):
    draft = "--draft" in args
    story = load(root)
    cast = story["cast"]
    canvas = {"width": 1080, "height": 1920, "fps": 30, "background": "#000000", **story.get("canvas", {})}
    max_len = 14 if canvas["width"] <= canvas["height"] else 24
    tl = {"canvas": canvas, "shots": [], "texts": [], "captions": [], "audio": []}
    cues, problems, t = [], [], 0.0
    for shot in story["shots"]:
        lines = shot.get("lines", [])
        lip = bool(shot.get("lipsync"))
        lead = 0.0 if lip else shot.get("lead", 0.2)
        gap, tail = shot.get("gap", 0.25), 0.0 if lip else shot.get("tail", 0.3)
        cur, placed = t + lead, []
        for line in lines:
            src = audio_of(root, line["id"])
            dur = probe(src) if src else None
            if dur is None:
                if not draft:
                    problems.append(f"{line['id']}: no audio/{line['id']}.mp3 (use --draft to estimate)")
                dur = estimate_seconds(line["text"], story.get("language"))
            placed.append((line, src, cur, dur))
            cur += dur + gap
        need = shot.get("duration") or 2.0
        if placed:
            need = max(shot.get("duration", 0), placed[-1][2] + placed[-1][3] + tail - t)
        need = round(need * canvas["fps"]) / canvas["fps"]
        src = shot.get("src")
        if not src or not (root / src).exists():
            if draft:
                src = draft_card(root, shot, canvas)
            else:
                problems.append(f"{shot['id']}: src {src!r} not found")
                src = src or "MISSING"
        entry = {"src": src, "duration": need}
        is_video = src.lower().endswith(VIDEO_EXT)
        if is_video:
            have = probe(root / src)
            if have and have + 0.04 < need and not draft:
                problems.append(f"{shot['id']}: clip is {have:.2f} s, the shot needs {need:.2f} s (it would freeze)")
            if lip:
                entry["volume"] = 1
        elif not shot.get("still"):
            entry["kenBurns"] = {"from": {"scale": 1.0}, "to": {"scale": 1.08}}
        if shot.get("transition"):
            entry["transition"] = shot["transition"]
        tl["shots"].append(entry)
        for tx in shot.get("texts", []):
            at = tx.get("at", 0)
            tl["texts"].append({**{k: v for k, v in tx.items() if k != "at"}, "start": round(t + at, 3),
                                "duration": tx.get("duration", round(need - at, 3))})
        for line, asrc, at, dur in placed:
            if asrc and not (lip and is_video):   # a lipsync clip carries the line itself
                tl["audio"].append({"src": str(asrc.relative_to(root)), "start": round(at, 3)})
            shown = line.get("caption", line["text"])
            words = None
            wp = root / "audio" / (line["id"] + ".words.json")
            if "caption" not in line and wp.exists():
                words = [{"text": w["text"], "start": round(at + w["start"], 3),
                          "end": round(at + max(w["end"], w["start"] + 0.05), 3)} for w in read_words(wp)[1]] or None
            if not words and shown:
                words = even_words(chunks(shown, story.get("language")), at, dur)
            limit = max_len if CJK.search(shown or "") else round(max_len * 1.9)
            groups = group(words, limit) if words and line.get("caption") != "" else []
            color = (cast.get(line.get("who")) or {}).get("color")
            for g in groups:
                cap = {"words": g, "position": story.get("caption_position", "lower")}
                if color:
                    cap["highlightColor"] = color
                tl["captions"].append(cap)
            cues.append({"line": line["id"], "who": line.get("who"), "shot": shot["id"], "T": round(at, 3), "dur": round(dur, 3)})
        cues.append({"shot": shot["id"], "T": round(t, 3), "dur": need, "lipsync": lip})
        t += need
    hook = story.get("hook") or {}
    if hook.get("text"):
        tl["texts"].insert(0, {"text": hook["text"], "start": 0, "duration": hook.get("duration", 2.0), "style": "hook",
                               "position": hook.get("position", "upper")})
    end = story.get("end") or {}
    if end.get("duration"):
        src = end.get("src")
        if not src or not (root / src).exists():
            src = draft_card(root, {"id": "end", "visual": ""}, canvas)
        tl["shots"].append({"src": src, "duration": end["duration"], "transition": {"type": "crossfade", "duration": 0.3}})
        if end.get("text"):
            tl["texts"].append({"text": end["text"], "start": round(t + 0.2, 3), "duration": end["duration"] - 0.2,
                                "style": end.get("style", "title"), "position": end.get("position", "center")})
        t += end["duration"]
    music = story.get("music") or {}
    if music.get("src") and (root / music["src"]).exists():
        tl["audio"].append({"src": music["src"], "start": 0, "volume": music.get("volume", 0.18)})
    for p in problems:
        print("ERROR " + p)
    if problems:
        sys.exit(1)
    (root / "timeline.json").write_text(json.dumps(tl, ensure_ascii=False, indent=1))
    (root / "cues.json").write_text(json.dumps({"total": round(t, 3), "cues": cues}, ensure_ascii=False, indent=1))
    for c in cues:
        if "line" not in c:
            print(f"{c['shot']:>6}  {c['T']:>6.2f} s  needs {c['dur']:.2f} s" + ("  (lipsync: clip made from the line audio)" if c["lipsync"] else ""))
    print(f"total {t:.2f} s -> timeline.json" + ("  (draft: placeholders for missing media)" if draft else ""))


if __name__ == "__main__":
    cmds = {"check": cmd_check, "trim": cmd_trim, "verify": cmd_verify, "timeline": cmd_timeline}
    if len(sys.argv) < 3 or sys.argv[1] not in cmds:
        print(__doc__)
        sys.exit(64)
    cmds[sys.argv[1]](Path(sys.argv[2]).resolve(), sys.argv[3:])
