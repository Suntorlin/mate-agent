# ruff: noqa: RUF001, RUF002 -- Chinese punctuation and number signs are intended
"""media-edit fxcaptions: Douyin-style effect captions for a talking-head clip.

Two layers over the untouched footage:
- the rail: the spoken line, word by word, in front of the speaker, with keywords popping in the
  accent colour;
- heroes: a few big words that slam in *behind* the speaker (MODNet portrait matte), with a shake,
  a flash and speed lines. At most one per sentence, never two on screen at once.

`--plan-only` writes <prefix>.fx.json (lines, suggested keywords and heroes, where the head and the
chin are) for editing; `--plan` renders it. With neither, the suggested plan is rendered directly.
"""

from __future__ import annotations

import json
import math
import re
import subprocess
from pathlib import Path

from .asr import MODEL_HELP, load_or_transcribe
from .captions import Word, break_lines, group_words
from .common import AAC, FASTSTART, MODELS, X264, Timer, emit, font_file, log, probe

ACCENT = "#FFE14D"
INK = (20, 20, 20)
# Douyin's own UI covers the bottom ~22% (title, music, comment box) and a column on the right
# (like/comment/share buttons); captions stay out of both.
SAFE_TOP, SAFE_BOTTOM, SAFE_RIGHT = 0.08, 0.78, 0.86
HERO_TOP = 0.04  # a hero may slam in higher than the rail: it is on screen for a beat
NUMERAL = re.compile(
    r"[0-9０-９.,，×x+＋%％]*[0-9０-９]+[0-9０-９.%％万千亿倍成年月天个次元块岁分秒w+]*"
    r"|[×x+＋]?[零一二两三四五六七八九十百千万半几]+[倍成年月天日个次万元块岁分秒%]+"
    r"|[×x+＋]?[两三四五六七八九十百千万]+"
)
HERO_GAP = 0.6  # seconds between one hero leaving and the next arriving
SLAM, SETTLE, EXIT = 0.16, 0.1, 0.22
# How much of a hero's lettering the speaker may cover at its peak: enough to tuck the lower edge
# behind the head, never so much that a digit is lost (a digit half hidden is unreadable).
COVER_MIN, COVER_MAX, CHAR_MAX = 0.10, 0.35, 0.35
END_SLACK = 0.05  # a hero whose `until` is this close to the end runs to the end and never exits


# ---------------------------------------------------------------- subject: face, head top, matte


class Matte:
    """MODNet portrait matting (Apache-2.0, /opt/media/models/modnet.onnx) on CPU."""

    def __init__(self, short_edge: int = 384) -> None:
        import onnxruntime as ort

        options = ort.SessionOptions()
        options.log_severity_level = 3
        self.session = ort.InferenceSession(
            str(MODELS / "modnet.onnx"), options, providers=["CPUExecutionProvider"]
        )
        self.short = short_edge

    def __call__(self, rgb):
        import cv2
        import numpy as np

        height, width = rgb.shape[:2]
        scale = self.short / min(width, height)
        w = max(32, round(width * scale / 32) * 32)
        h = max(32, round(height * scale / 32) * 32)
        x = cv2.resize(rgb, (w, h), interpolation=cv2.INTER_AREA).astype(np.float32) / 127.5 - 1
        alpha = self.session.run(None, {"input": x.transpose(2, 0, 1)[None]})[0][0, 0]
        return cv2.resize(alpha, (width, height), interpolation=cv2.INTER_LINEAR).clip(0, 1)


def frames(path: Path, width: int, height: int, times: list[float] | None = None):
    """Decode RGB frames at the output size: all of them, or one per requested time."""
    import numpy as np

    size = width * height * 3
    scale = ["-vf", f"scale={width}:{height}:flags=lanczos"]
    if times is not None:
        for t in times:
            out = subprocess.run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-ss",
                    f"{t:.3f}",
                    "-i",
                    str(path),
                    "-frames:v",
                    "1",
                    *scale,
                    "-f",
                    "rawvideo",
                    "-pix_fmt",
                    "rgb24",
                    "-",
                ],
                capture_output=True,
                check=True,
            ).stdout
            if len(out) >= size:
                yield t, np.frombuffer(out[:size], np.uint8).reshape(height, width, 3)
        return
    proc = subprocess.Popen(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(path),
            *scale,
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
        ],
        stdout=subprocess.PIPE,
    )
    assert proc.stdout
    while True:
        buf = proc.stdout.read(size)
        if len(buf) < size:
            break
        yield None, np.frombuffer(buf, np.uint8).reshape(height, width, 3)
    proc.wait()


def analyse_subject(path: Path, width: int, height: int, duration: float, matte: Matte) -> dict:
    """Median face box (YuNet) and head top (matte) over ~12 frames, as fractions of the frame."""
    import cv2
    import numpy as np

    count = max(4, min(12, int(duration * 2)))
    times = [duration * (i + 0.5) / count for i in range(count)]
    detector = cv2.FaceDetectorYN.create(str(MODELS / "yunet.onnx"), "", (width, height), 0.7)
    faces, tops, coverage = [], [], []
    for _, rgb in frames(path, width, height, times):
        _, found = detector.detect(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
        alpha = matte(rgb)
        coverage.append(float((alpha > 0.5).mean()))
        if found is None or not len(found):
            continue
        x, y, w, h = max(found, key=lambda f: f[2] * f[3])[:4]
        faces.append((x, y, x + w, y + h))
        band = alpha[:, int(max(0, x - w * 0.2)) : int(min(width, x + w * 1.2))]
        rows = np.where((band > 0.5).mean(axis=1) > 0.15)[0]
        if len(rows):
            tops.append(rows[0])
    if not faces:
        return {
            "face": None,
            "head_top": None,
            "subject_area": round(float(np.median(coverage)), 3),
        }
    face = np.median(np.array(faces), axis=0)
    return {
        "face": [
            round(float(face[0] / width), 3),
            round(float(face[1] / height), 3),
            round(float(face[2] / width), 3),
            round(float(face[3] / height), 3),
        ],
        "head_top": round(float(np.median(tops) / height), 3)
        if tops
        else round(float(face[1] / height) - 0.06, 3),
        "subject_area": round(float(np.median(coverage)), 3),
        "faces_seen": f"{len(faces)}/{count}",
    }


# ---------------------------------------------------------------- the plan


def punctuated_words(data: dict) -> list[Word]:
    """Whisper writes Chinese without punctuation but marks a pause with a leading space and ends a
    segment at a sentence; turn those into ，and 。 so lines and sentences break where she breathes."""
    out: list[Word] = []
    for segment in data["segments"]:
        words = [w for w in segment["words"] if w["word"].strip()]
        for w in words:
            text = w["word"]
            if out and text[:1].isspace() and re.search(r"[\u3400-\u9fff]$", out[-1].text):
                out[-1] = Word(out[-1].text + "，", out[-1].start, out[-1].end)
            out.append(Word(text.strip(), w["start"], w["end"]))
        if out and not re.search(r"[，。！？,.!?…]$", out[-1].text):
            out[-1] = Word(out[-1].text + "。", out[-1].start, out[-1].end)
    return out


PUNCT = "，。！？、；：,.!?;:…“”\"' "


def bare(text: str) -> str:
    return text.strip(PUNCT)


def joined(pieces: list[str]) -> str:
    """Words as one line: a space only between two Latin/number words (AI 做 -> AI做)."""
    out = ""
    for piece in filter(None, pieces):
        if out and re.match(r"[A-Za-z0-9]", piece) and re.search(r"[A-Za-z0-9]$", out):
            out += " "
        out += piece
    return out


def is_numeral(text: str) -> bool:
    return bool(NUMERAL.fullmatch(text.strip("，。！？、,.!?：:“”\"' ")))


DIGITS = {
    "零": 0,
    "一": 1,
    "二": 2,
    "两": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
}


def cn_number(text: str) -> int | None:
    """一..九十九 (and 两) as an int; None for anything else."""
    if not text or any(c not in DIGITS and c != "十" for c in text):
        return None
    if "十" not in text:
        return DIGITS[text] if len(text) == 1 else None
    tens, _, ones = text.partition("十")
    return (DIGITS.get(tens, 0) if tens else 1) * 10 + (DIGITS.get(ones, 0) if ones else 0)


def punchy(text: str, before: str) -> str:
    """A hero number as Douyin writes it: 三倍 -> ×3, 四成 -> +40% (−40% after 少/降/减), 三年 -> 3年."""
    m = re.fullmatch(r"([零一二两三四五六七八九十]+)(倍|成|年|个月|天|万|次|个|岁)", text)
    if not m or cn_number(m.group(1)) is None:
        return text
    n, unit = cn_number(m.group(1)), m.group(2)
    if unit == "倍":
        return f"×{n}"
    if unit == "成":
        return f"{'−' if re.search(r'[少降减跌掉]', before) else '+'}{n * 10}%"
    return f"{n}{unit}"


def phrases_of(lines: list[list[Word]]) -> list[list[Word]]:
    """Comma-separated phrases across lines."""
    out: list[list[Word]] = [[]]
    for w in (w for line in lines for w in line):
        out[-1].append(w)
        if re.search(r"[，。！？,.!?;；…]$", w.text):
            out.append([])
    return [p for p in out if p]


def suggest(lines: list[list[Word]], duration: float) -> tuple[list[str], list[dict]]:
    """Keywords: numbers with their unit, then the clip's top terms. Heroes: at most one per
    phrase and about one per 4 s, growth numbers (倍, 成, %, 万) and a short closing line first."""
    import jieba.analyse

    jieba.setLogLevel(60)
    clean = [bare(w.text) for line in lines for w in line]
    keywords = [t for t in dict.fromkeys(clean) if t and is_numeral(t)]
    budget = len(keywords) + max(2, len(lines) // 2)
    for tag in jieba.analyse.extract_tags("".join(clean), topK=budget * 3):
        if len(keywords) >= budget:
            break
        if len(tag) >= 2 and tag in clean and tag not in keywords:
            keywords.append(tag)
    candidates = []
    phrases = phrases_of(lines)
    for phrase in phrases:
        pick = next((w for w in phrase if is_numeral(bare(w.text))), None)
        if pick is None:
            continue
        lead = "".join(bare(w.text) for w in phrase[: phrase.index(pick)])
        label = re.sub(r"(涨|多|少|增长|提升|上涨|翻|达到|超过|是|有|就|了)+$", "", lead)
        score = 3 if re.search(r"[倍成%％万wW]", bare(pick.text)) else 2
        candidates.append(
            (
                score,
                {
                    "text": punchy(bare(pick.text), lead),
                    "label": label if 2 <= len(label) <= 8 else "",
                    "at": pick.start,
                    "until": phrase[-1].end + 0.3,
                },
            )
        )
    closing = "".join(bare(w.text) for w in phrases[-1]) if phrases else ""
    if 2 <= len(closing) <= 6:
        candidates.append(
            (3, {"text": closing, "label": "", "at": phrases[-1][0].start, "until": duration})
        )
    cap = max(1, round(duration / 4))
    chosen = sorted(candidates, key=lambda c: (-c[0], c[1]["at"]))[:cap]
    return keywords, space_heroes([c[1] for c in chosen], duration)


def space_heroes(heroes: list[dict], duration: float) -> list[dict]:
    """Sort, keep at least HERO_GAP between heroes and each on screen at least 1.2 s (0.8 s when
    the next one cuts it short; one that still does not fit is dropped), inside the clip."""
    out: list[dict] = []
    for hero in sorted(heroes, key=lambda h: h["at"]):
        at = max(0.0, float(hero["at"]))
        if out and at < out[-1]["until"] + HERO_GAP:
            out[-1]["until"] = round(max(out[-1]["at"] + 0.8, at - HERO_GAP), 3)
            if at < out[-1]["until"] + HERO_GAP:
                continue
        until = min(duration, max(float(hero.get("until") or 0), at + 1.2))
        out.append({**hero, "at": round(at, 3), "until": round(until, 3)})
    return out


def make_plan(lines: list[list[Word]], subject: dict, info, size, accent: str) -> dict:
    keywords, heroes = suggest(lines, info.duration)
    face = subject.get("face")
    chin = face[3] if face else 0.5
    rail_y = min(0.74, max(0.56, chin + 0.12))
    head_top = subject.get("head_top") or 0.2
    return {
        "video": {
            "width": size[0],
            "height": size[1],
            "fps": round(info.fps, 3),
            "duration": round(info.duration, 3),
        },
        "subject": subject,
        "accent": accent,
        "rail_y": round(rail_y, 3),
        "hero_bottom": round(min(0.5, head_top + 0.07), 3),
        "keywords": keywords,
        "heroes": heroes,
        "lines": [
            {
                "start": round(line[0].start, 3),
                "end": round(line[-1].end, 3),
                "text": joined([bare(w.text) for w in line]),
                "words": [
                    {"text": w.text, "start": round(w.start, 3), "end": round(w.end, 3)}
                    for w in line
                ],
            }
            for line in lines
        ],
    }


# ---------------------------------------------------------------- drawing


def hex_rgb(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


class Sprites:
    """Text rendered once to premultiplied RGBA arrays (fill, dark stroke, soft drop shadow)."""

    def __init__(self) -> None:
        self.path, self.index = font_file("Noto Sans CJK SC:bold")
        self.fonts: dict[int, object] = {}
        self.cache: dict[tuple, object] = {}

    def font(self, size: int):
        from PIL import ImageFont

        if size not in self.fonts:
            self.fonts[size] = ImageFont.truetype(self.path, size, index=self.index)
        return self.fonts[size]

    def width(self, text: str, size: int) -> float:
        return self.font(size).getlength(text)

    def text(self, text: str, size: int, fill, *, stroke: float = 0.1, extrude: float = 0.0):
        import numpy as np
        from PIL import Image, ImageDraw, ImageFilter

        key = (text, size, fill, stroke, extrude)
        if key in self.cache:
            return self.cache[key]
        font = self.font(size)
        sw = max(2, round(size * stroke))
        left, top, right, bottom = font.getbbox(text, stroke_width=sw)
        pad = sw + round(size * (extrude + 0.08))
        w, h = right - left + 2 * pad, bottom - top + 2 * pad
        image = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)
        origin = (pad - left, pad - top)
        shadow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        ImageDraw.Draw(shadow).text(
            (origin[0] + size * 0.03, origin[1] + size * 0.05),
            text,
            font=font,
            fill=(0, 0, 0, 150),
            stroke_width=sw,
            stroke_fill=(0, 0, 0, 150),
        )
        image.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(size * 0.05)))
        steps = max(0, round(size * extrude))
        for d in range(steps, 0, -1):  # a solid 3D extrusion down-right
            draw.text(
                (origin[0] + d * 0.6, origin[1] + d),
                text,
                font=font,
                fill=(*INK, 255),
                stroke_width=sw,
                stroke_fill=(*INK, 255),
            )
        draw.text(
            origin,
            text,
            font=font,
            fill=(*fill, 255),
            stroke_width=sw,
            stroke_fill=(*INK, 255),
        )
        rgba = np.asarray(image, dtype=np.float32) / 255.0
        rgba[..., :3] *= rgba[..., 3:4]
        self.cache[key] = rgba
        return rgba


def bands(width: int, count: int) -> list[tuple[int, int]]:
    """Column ranges of `count` equal-width characters (CJK glyphs are monospaced) in a width."""
    count = max(1, count)
    return [
        (
            round(width * i / count),
            max(round(width * (i + 1) / count), round(width * i / count) + 1),
        )
        for i in range(count)
    ]


def ease_out(x: float) -> float:
    x = min(1.0, max(0.0, x))
    return 1 - (1 - x) ** 3


def place(canvas, sprite, cx: float, cy: float, scale: float = 1.0, opacity: float = 1.0) -> None:
    """Composite a premultiplied RGBA sprite onto a premultiplied RGBA canvas, centred."""
    import cv2

    if opacity <= 0.01 or scale <= 0.01:
        return
    if abs(scale - 1) > 0.01:
        h, w = sprite.shape[:2]
        sprite = cv2.resize(
            sprite,
            (max(1, round(w * scale)), max(1, round(h * scale))),
            interpolation=cv2.INTER_LINEAR,
        )
    h, w = sprite.shape[:2]
    x0, y0 = round(cx - w / 2), round(cy - h / 2)
    H, W = canvas.shape[:2]
    sx0, sy0 = max(0, -x0), max(0, -y0)
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(W, x0 + w - sx0), min(H, y0 + h - sy0)
    if x1 <= x0 or y1 <= y0:
        return
    s = sprite[sy0 : sy0 + y1 - y0, sx0 : sx0 + x1 - x0] * opacity
    region = canvas[y0:y1, x0:x1]
    region *= 1 - s[..., 3:4]
    region += s


def speed_lines(height: int, width: int, cx: float, cy: float, strength: float, seed: int):
    """Thin white radial wedges from (cx, cy) outward, as a premultiplied RGBA layer."""
    import numpy as np
    from PIL import Image, ImageDraw

    rng = np.random.default_rng(seed)
    image = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(image)
    reach = math.hypot(width, height)
    for angle in rng.uniform(0, 2 * math.pi, 44):
        spread = rng.uniform(0.008, 0.024)
        inner = reach * rng.uniform(0.12, 0.2)
        points = [
            (cx + math.cos(angle) * inner, cy + math.sin(angle) * inner),
            (cx + math.cos(angle - spread) * reach, cy + math.sin(angle - spread) * reach),
            (cx + math.cos(angle + spread) * reach, cy + math.sin(angle + spread) * reach),
        ]
        draw.polygon(points, fill=int(255 * rng.uniform(0.5, 0.9)))
    a = np.asarray(image, dtype=np.float32)[..., None] / 255.0 * strength
    return np.concatenate([a, a, a, a], axis=2)


class Renderer:
    def __init__(self, plan: dict, sprites: Sprites, peak_alphas: dict | None = None) -> None:
        self.plan = plan
        self.s = sprites
        self.W, self.H = plan["video"]["width"], plan["video"]["height"]
        self.accent = hex_rgb(plan.get("accent") or ACCENT)
        self.keywords = {k.strip() for k in plan.get("keywords", []) if k.strip()}
        self.rail_em = round(self.W * 0.078)
        self.rail_y = plan.get("rail_y", 0.66) * self.H
        peaks = peak_alphas or {}
        self.heroes = [
            self.hero_layout(h, i, peaks.get(i)) for i, h in enumerate(plan.get("heroes", []))
        ]

    # --- rail

    def is_keyword(self, text: str) -> bool:
        t = bare(text)
        return bool(t) and (
            t in self.keywords or any(len(k) >= 2 and k in t for k in self.keywords)
        )

    def rail_line(self, t: float):
        lines = self.plan["lines"]
        for i, line in enumerate(lines):
            nxt = lines[i + 1]["start"] if i + 1 < len(lines) else math.inf
            if line["words"][0]["start"] - 0.05 <= t < min(nxt, line["end"] + 0.35):
                return line
        return None

    def draw_rail(self, canvas, t: float) -> None:
        line = self.rail_line(t)
        if not line:
            return
        items = []
        for w in line["words"]:
            text = bare(w["text"])
            if not text:
                continue
            key = self.is_keyword(text)
            size = round(self.rail_em * (1.22 if key else 1.0))
            sprite = self.s.text(text, size, self.accent if key else (255, 255, 255), stroke=0.11)
            items.append((w, sprite, key, size))
        if not items:
            return
        track = self.rail_em * 0.02
        advances = [self.s.width(bare(w["text"]), sp_size) for w, _, _, sp_size in items]
        total = sum(advances) + track * (len(items) - 1)
        limit = self.W * (SAFE_RIGHT - 0.06)
        shrink = min(1.0, limit / total)
        x = (self.W * (0.06 + SAFE_RIGHT)) / 2 - total * shrink / 2
        for (w, sprite, key, _), advance in zip(items, advances, strict=True):
            width = advance * shrink
            age = t - w["start"]
            if age >= -0.02:
                pop = 0.45 if key else 0.25
                scale = shrink * (1 + pop * (1 - ease_out(age / 0.14)))
                if key and 0.14 < age < 0.4:
                    scale *= 1 + 0.06 * math.sin((age - 0.14) / 0.26 * math.pi)
                place(
                    canvas, sprite, x + width / 2, self.rail_y, scale, min(1.0, (age + 0.02) / 0.06)
                )
            x += width + track * shrink

    # --- heroes

    def hero_layout(self, hero: dict, index: int, alpha=None) -> dict:
        """Size and spot of a hero. With the speaker's matte at its peak: the largest size, then the
        most central and highest spot, where the speaker covers COVER_MIN-COVER_MAX of the lettering
        and no character more than CHAR_MAX (only the lower edge tucked behind the head). When no
        spot fits, the one closest to that, erring towards less covered. A hero with its own
        'bottom' (fraction of the height) and optional 'x' (fraction of the width, centre) is
        placed there."""
        import cv2
        import numpy as np

        text = hero["text"].strip()
        base = min(self.W * 0.30, self.W * 0.80 / max(1.0, self.s.width(text, 100) / 100))
        base *= min(1.0, max(0.3, float(hero.get("scale") or 1.0)))  # the plan may shrink one
        label_text = (hero.get("label") or "").strip()

        def build(size: int):
            return self.s.text(text, size, self.accent, stroke=0.09, extrude=0.08)

        choice = None
        if hero.get("bottom") or alpha is None:
            main = build(round(base))
            bottom = hero.get("bottom") or self.plan.get("hero_bottom", 0.27)
            cy = max(HERO_TOP * self.H + main.shape[0] / 2, bottom * self.H - main.shape[0] / 2)
            choice = (main, (hero.get("x") or 0.5) * self.W, cy)
        else:
            k = 4  # search on a quarter-size matte
            small = (
                cv2.resize(alpha, (self.W // k, self.H // k), interpolation=cv2.INTER_AREA) > 0.5
            )
            fallback = None
            for factor in (1.0, 0.85, 0.72, 0.6, 0.5):
                main = build(round(base * factor))
                h, w = main.shape[:2]
                glyph = (
                    cv2.resize(
                        (main[..., 3] > 0.5).astype(np.uint8), (max(1, w // k), max(1, h // k))
                    )
                    > 0
                )
                gh, gw = glyph.shape
                left_room = self.W * 0.06 + w / 2
                right_room = self.W * SAFE_RIGHT - w / 2
                xs = sorted(
                    {
                        min(max(self.W / 2 + d * self.W, left_room), right_room)
                        for d in (0, -0.06, 0.06, -0.12, 0.12, -0.18, 0.18)
                    },
                    key=lambda x: abs(x - self.W / 2),
                )
                for cx in xs:
                    for cy in np.arange(HERO_TOP * self.H + h / 2, self.H * 0.5, self.H * 0.01):
                        y0, x0 = round((cy - h / 2) / k), round((cx - w / 2) / k)
                        window = small[y0 : y0 + gh, x0 : x0 + gw]
                        mask = glyph[: window.shape[0], : window.shape[1]]
                        covered = float(window[mask].mean()) if mask.any() else 0.0
                        worst = max(
                            (
                                float(window[:, a:b][mask[:, a:b]].mean())
                                if mask[:, a:b].any()
                                else 0.0
                            )
                            for a, b in bands(mask.shape[1], len(text))
                        )
                        if COVER_MIN <= covered <= COVER_MAX and worst <= CHAR_MAX:
                            choice = (main, cx, float(cy))
                            break
                        miss = (
                            max(0.0, COVER_MIN - covered)
                            + max(0.0, covered - COVER_MAX) * 2
                            + max(0.0, worst - CHAR_MAX) * 3
                        )
                        if fallback is None or miss < fallback[0]:
                            fallback = (miss, (main, cx, float(cy)))
                    if choice:
                        break
                if choice:
                    break
            choice = choice or fallback[1]
        main, cx, cy = choice
        size = main.shape[0]
        label = (
            self.s.text(label_text, round(size * 0.24), (255, 255, 255), stroke=0.12)
            if label_text
            else None
        )
        return {
            **hero,
            "main": main,
            "label_sprite": label,
            "cx": cx,
            "cy": cy,
            "seed": index + 1,
            "to_end": runs_to_end(self.plan, hero),
        }

    def active_hero(self, t: float):
        return next(
            (h for h in self.heroes if h["at"] <= t and (t < h["until"] or h["to_end"])), None
        )

    def draw_hero(self, layer, hero: dict, t: float) -> None:
        age, left = t - hero["at"], hero["until"] - t
        if age < SLAM:
            scale, opacity = 1.9 - 0.95 * ease_out(age / SLAM), min(1.0, age / 0.05)
        elif age < SLAM + SETTLE:
            scale, opacity = 0.95 + 0.05 * ease_out((age - SLAM) / SETTLE), 1.0
        else:
            scale, opacity = 1.0, 1.0
        if left < EXIT and not hero["to_end"]:  # the closing hero stays up through the --hold
            scale *= 1 + 0.1 * (1 - left / EXIT)
            opacity *= left / EXIT
        if SLAM * 0.8 < age < SLAM + 0.45:
            strength = 0.85 * (1 - (age - SLAM * 0.8) / 0.45)
            layer += speed_lines(self.H, self.W, hero["cx"], hero["cy"], strength, hero["seed"]) * (
                1 - layer[..., 3:4]
            )
        main = hero["main"]
        place(layer, main, hero["cx"], hero["cy"], scale, opacity)
        if hero["label_sprite"] is not None:
            label = hero["label_sprite"]
            ly = hero["cy"] - main.shape[0] * scale / 2 + label.shape[0] * 0.2
            lx = hero["cx"] - main.shape[1] * scale / 2 + label.shape[1] / 2 + main.shape[1] * 0.04
            place(layer, label, lx, ly, 1.0, opacity * min(1.0, max(0.0, (age - SLAM) / 0.12)))

    # --- one frame

    def frame(self, rgb, t: float, alpha):
        import numpy as np

        out = rgb.astype(np.float32) / 255.0
        hero = self.active_hero(t)
        if hero is not None:
            layer = np.zeros((self.H, self.W, 4), np.float32)
            self.draw_hero(layer, hero, t)
            behind = out * (1 - layer[..., 3:4]) + layer[..., :3]
            if alpha is not None:
                a = alpha[..., None]
                out = out * a + behind * (1 - a)
            else:
                out = behind
        rail = np.zeros((self.H, self.W, 4), np.float32)
        self.draw_rail(rail, t)
        out = out * (1 - rail[..., 3:4]) + rail[..., :3]
        if hero is not None:
            age = t - hero["at"]
            if SLAM * 0.9 <= age < SLAM * 0.9 + 0.07:
                out = out * 0.6 + 0.4
            if SLAM * 0.9 <= age < SLAM + 0.28:
                out = self.shake(out, age - SLAM * 0.9, hero["seed"])
        return (out.clip(0, 1) * 255 + 0.5).astype(np.uint8)

    def shake(self, image, age: float, seed: int):
        import cv2

        decay = 1 - age / 0.37
        amp = self.W * 0.012 * decay
        dx = amp * math.sin(age * 90 + seed)
        dy = amp * math.cos(age * 70 + seed * 2)
        zoom = 1.025
        matrix = [[zoom, 0, dx - (zoom - 1) * self.W / 2], [0, zoom, dy - (zoom - 1) * self.H / 2]]
        import numpy as np

        return cv2.warpAffine(
            image, np.float32(matrix), (self.W, self.H), borderMode=cv2.BORDER_REFLECT
        )


# ---------------------------------------------------------------- render + checks


def runs_to_end(plan: dict, hero: dict) -> bool:
    return float(hero["until"]) >= plan["video"]["duration"] - END_SLACK


def needs_matte(plan: dict, t: float) -> bool:
    return any(
        h["at"] - 0.05 <= t and (t < h["until"] + 0.05 or runs_to_end(plan, h))
        for h in plan.get("heroes", [])
    )


def render(source: Path, plan: dict, out: Path, matte: Matte, hold: float, has_audio: bool) -> dict:

    W, H, fps = plan["video"]["width"], plan["video"]["height"], plan["video"]["fps"]
    duration = plan["video"]["duration"]
    peak_times = [
        min(duration - 0.05, h["at"] + SLAM + SETTLE + 0.15) for h in plan.get("heroes", [])
    ]
    peak_alphas = {i: matte(rgb) for i, (_, rgb) in enumerate(frames(source, W, H, peak_times))}
    renderer = Renderer(plan, Sprites(), peak_alphas)
    total = plan["video"]["duration"] + hold
    audio = (
        [
            "-i",
            str(source),
            "-map",
            "0:v",
            "-map",
            "1:a:0",
            *AAC,
            "-af",
            "apad",
            "-t",
            f"{total:.3f}",
        ]
        if has_audio
        else ["-map", "0:v"]
    )
    encoder = subprocess.Popen(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-s",
            f"{W}x{H}",
            "-r",
            str(fps),
            "-i",
            "-",
            *audio,
            *X264,
            *FASTSTART,
            str(out),
        ],
        stdin=subprocess.PIPE,
    )
    assert encoder.stdin
    checks, previous_alpha, last, index, matted = [], None, None, 0, 0
    peaks = {round(h["at"] + SLAM + SETTLE + 0.15, 2): h for h in renderer.heroes}
    for _, rgb in frames(source, W, H):
        t = index / fps
        alpha = None
        if needs_matte(plan, t):
            alpha = matte(rgb)
            matted += 1
            if previous_alpha is not None:
                alpha = alpha * 0.7 + previous_alpha * 0.3  # damp frame-to-frame flicker
            previous_alpha = alpha
        else:
            previous_alpha = None
        last = renderer.frame(rgb, t, alpha)
        encoder.stdin.write(last.tobytes())
        for when, hero in peaks.items():
            if abs(t - when) < 0.5 / fps and alpha is not None:
                checks.append(hero_check(renderer, hero, t, alpha, last))
        index += 1
    for _ in range(round(hold * fps)):
        encoder.stdin.write(last.tobytes())
    encoder.stdin.close()
    if encoder.wait():
        raise SystemExit("ffmpeg encode failed")
    return {"frames": index, "matted_frames": matted, "heroes": checks}


def hero_check(renderer: Renderer, hero: dict, t: float, alpha, frame) -> dict:
    """How much of the hero's lettering the speaker covers at its peak, in all and for the worst
    character (want COVER_MIN-COVER_MAX and at most CHAR_MAX, with a little slack)."""
    import numpy as np

    layer = np.zeros((renderer.H, renderer.W, 4), np.float32)
    place(layer, hero["main"], hero["cx"], hero["cy"])
    glyph = layer[..., 3] > 0.5
    hidden = alpha > 0.5
    covered = float(hidden[glyph].mean()) if glyph.any() else 0.0
    worst = 0.0
    if glyph.any():
        rows, cols = np.where(glyph.any(axis=1))[0], np.where(glyph.any(axis=0))[0]
        box = (slice(rows[0], rows[-1] + 1), slice(cols[0], cols[-1] + 1))
        g, a = glyph[box], hidden[box]
        worst = max(
            (float(a[:, x0:x1][g[:, x0:x1]].mean()) if g[:, x0:x1].any() else 0.0)
            for x0, x1 in bands(g.shape[1], len(hero["text"].strip()))
        )
    note = "ok"
    if covered > COVER_MAX + 0.05 or worst > CHAR_MAX + 0.1:
        note = (
            "too hidden to read: raise it (smaller hero 'bottom'), give it a smaller 'scale' "
            "or shorten the text"
        )
    elif covered < COVER_MIN - 0.05:
        note = "barely behind the speaker: lower it (larger 'bottom') for the tucked-behind look"
    top = float(np.where(glyph.any(axis=1))[0][0] / renderer.H) if glyph.any() else 0.0
    return {
        "text": hero["text"],
        "at": hero["at"],
        "covered": round(covered, 2),
        "worst_char": round(worst, 2),
        "top": round(top, 3),
        "note": note,
    }


def contact(video: Path, plan: dict, out: Path) -> None:
    """Peak frame of every hero plus three rail moments, side by side."""
    times = [h["at"] + SLAM + SETTLE + 0.15 for h in plan.get("heroes", [])]
    lines = plan["lines"]
    for i in (0, len(lines) // 2, len(lines) - 1):
        if lines:
            times.append((lines[i]["start"] + lines[i]["end"]) / 2)
    times = sorted({round(t, 2) for t in times})[:8]
    inputs, filters = [], []
    for i, t in enumerate(times):
        inputs += ["-ss", f"{t:.2f}", "-i", str(video)]
        filters.append(f"[{i}:v]scale=360:-2,setpts=PTS-STARTPTS[v{i}]")
    stack = "".join(f"[v{i}]" for i in range(len(times)))
    graph = ";".join(filters) + (f";{stack}hstack=inputs={len(times)}" if len(times) > 1 else "")
    if len(times) == 1:
        graph = graph.replace("[v0]", "")
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            *inputs,
            "-filter_complex",
            graph,
            "-frames:v",
            "1",
            str(out),
        ],
        check=True,
    )


# ---------------------------------------------------------------- CLI


def add_parser(sub) -> None:
    p = sub.add_parser(
        "fxcaptions",
        help="Douyin-style effect captions: word-by-word rail + big words slammed in behind the speaker",
    )
    p.add_argument("input", help="a single-speaker talking-head video (one shot)")
    p.add_argument("-o", "--output", help="output prefix (default <input without extension>.fx)")
    p.add_argument("--words", help="reuse a words.json from transcribe/jumpcut instead of ASR")
    p.add_argument("--plan", help="render this fx.json (edited from --plan-only)")
    p.add_argument("--plan-only", action="store_true", help="write <prefix>.fx.json and stop")
    p.add_argument("--accent", default=ACCENT, help="keyword and hero colour (default #FFE14D)")
    p.add_argument(
        "--size",
        help="output WxH (default: the input, a 9:16 under 1080 wide is scaled to 1080x1920)",
    )
    p.add_argument("--hold", type=float, default=0.0, help="seconds to hold the last frame")
    p.add_argument("--model", default="turbo", help=MODEL_HELP)
    p.add_argument("--lang", help="language code (default: detect)")
    p.set_defaults(func=main)


def output_size(info, size: str | None) -> tuple[int, int]:
    if size:
        w, _, h = size.lower().partition("x")
        return int(w), int(h)
    if info.height > info.width and info.width < 1080:
        return 1080, round(info.height * 1080 / info.width / 2) * 2
    return info.width - info.width % 2, info.height - info.height % 2


def main(args) -> None:
    timer = Timer()
    source = Path(args.input)
    prefix = (
        Path(args.output) if args.output else source.with_suffix("").with_name(source.stem + ".fx")
    )
    prefix.parent.mkdir(parents=True, exist_ok=True)
    info = probe(source)
    if not info.has_video:
        raise SystemExit("fxcaptions needs a video of someone talking")
    matte = Matte()
    if args.plan:
        plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))
        plan["heroes"] = space_heroes(plan.get("heroes", []), plan["video"]["duration"])
    else:
        size = output_size(info, args.size)
        data = load_or_transcribe(
            str(source), args.words, args.model, args.lang, Path(f"{prefix}.words.json")
        )
        words = punctuated_words(data)
        if not words:
            raise SystemExit("no speech found")
        sprites = Sprites()
        em = round(size[0] * 0.068)
        measure = lambda text: sprites.width(text, round(em * 1.1)) + em * 0.2  # noqa: E731
        lines = break_lines(
            group_words(words), measure, size[0] * (SAFE_RIGHT - 0.06), max_seconds=3.0, pause=0.4
        )
        subject = analyse_subject(source, size[0], size[1], info.duration, matte)
        if not subject.get("face"):
            log("no face found: heroes will sit at the top third; check the contact sheet")
        plan = make_plan(lines, subject, info, size, args.accent)
        plan_path = Path(f"{prefix}.fx.json")
        plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=1), encoding="utf-8")
        if args.plan_only:
            emit(
                {
                    "plan": str(plan_path),
                    "lines": [line["text"] for line in plan["lines"]],
                    "keywords": plan["keywords"],
                    "heroes": [{k: h[k] for k in ("text", "at", "until")} for h in plan["heroes"]],
                    "subject": subject,
                    "seconds": timer.seconds(),
                }
            )
            return
    video = Path(f"{prefix}.mp4")
    result = render(source, plan, video, matte, args.hold, info.has_audio)
    sheet = Path(f"{prefix}.check.jpg")
    contact(video, plan, sheet)
    emit(
        {
            "video": str(video),
            "check": str(sheet),
            "size": f"{plan['video']['width']}x{plan['video']['height']}",
            "lines": len(plan["lines"]),
            "keywords": plan["keywords"],
            **result,
            "seconds": timer.seconds(),
        }
    )
