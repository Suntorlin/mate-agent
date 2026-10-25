"""media-edit captions: word-timed captions as SRT + ASS (+ Remotion captions), optionally burned in.

Lines are broken by measured pixel width with the font libass will draw, never inside a word
(Chinese is segmented with jieba), never with punctuation at a line start, and also at pauses,
sentence ends and a maximum on-screen duration.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from .asr import MODEL_HELP, flat_words, load_or_transcribe
from .common import MODELS, X264, Timer, emit, ffmpeg, font_family, font_file, log, probe

CJK = re.compile(r"[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]")
NO_LINE_START = set("，。！？、；：,.!?;:）)】」』”’…%‰·~～")  # noqa: RUF001
SENTENCE_END = re.compile(r"[。！？.!?…]$")  # noqa: RUF001
SOFT_BREAK = re.compile(r"[，、；：,;:。！？.!?…]$")  # noqa: RUF001
TRAILING_SOFT = re.compile(r"[，、；：,;:]+$")  # noqa: RUF001
STYLES = ("clean", "karaoke", "bilingual")
HALF_TO_FULL = dict(zip(",?!:;", "，？！：；", strict=True))  # noqa: RUF001
HIGHLIGHT = "&H004DE1FF"  # #FFE14D in ASS's &HAABBGGRR


@dataclass
class Word:
    text: str
    start: float
    end: float


def is_cjk(text: str) -> bool:
    return bool(CJK.search(text))


def fullwidth_punctuation(text: str) -> str:
    """Whisper sometimes writes ASCII , ? ! : ; in Chinese; use the full-width forms."""
    return re.sub(r"(?<=[\u3400-\u9fff])[,?!:;]", lambda m: HALF_TO_FULL[m.group()], text)


def group_words(words: list[Word]) -> list[Word]:
    """Merge ASR tokens into whole words: for CJK, tokens covering one jieba word become one."""
    text = "".join(w.text for w in words)
    if not is_cjk(text):
        return words
    text = fullwidth_punctuation(text)  # same length, so token boundaries stay put
    pos, normalized = 0, []
    for w in words:
        normalized.append(Word(text[pos : pos + len(w.text)], w.start, w.end))
        pos += len(w.text)
    words = normalized
    import jieba

    cache = MODELS / "jieba.cache"
    if cache.exists():
        jieba.dt.cache_file = str(cache)
    jieba.setLogLevel(60)
    owner = [i for i, w in enumerate(words) for _ in w.text]  # char position -> token index
    grouped, pos, last = [], 0, -1
    for piece in jieba.cut(text):
        indices = sorted(set(owner[pos : pos + len(piece)]))
        pos += len(piece)
        indices = [
            i for i in indices if i > last
        ]  # a token that spans two jieba words is used once
        if not indices:
            continue
        last = indices[-1]
        grouped.append(
            Word(
                "".join(words[i].text for i in indices),
                words[indices[0]].start,
                words[indices[-1]].end,
            )
        )
    return grouped


def line_text(line: list[Word]) -> str:
    return re.sub(r"\s+", " ", "".join(w.text for w in line)).strip()


def display_text(line: list[Word]) -> str:
    """What is shown: CJK lines drop trailing commas, as short-form captions do."""
    text = line_text(line)
    return TRAILING_SOFT.sub("", text) if is_cjk(text) else text


def phrases(words: list[Word], pause: float) -> list[list[Word]]:
    """Split at pauses and after punctuation: the natural places for a caption to change."""
    out: list[list[Word]] = []
    for word in words:
        if out and not (
            word.start - out[-1][-1].end > pause or SOFT_BREAK.search(out[-1][-1].text.strip())
        ):
            out[-1].append(word)
        elif out and word.text.strip()[:1] in NO_LINE_START:
            out[-1].append(word)  # punctuation never starts a line
        else:
            out.append([word])
    return out


def split_balanced(phrase: list[Word], fits) -> list[list[Word]]:
    """Bisect a phrase that does not fit at the word boundary giving the most even halves,
    never putting punctuation at the start of the second half; recurse until every part fits."""
    if fits(phrase) or len(phrase) < 2:
        return [phrase]
    choices = [i for i in range(1, len(phrase)) if phrase[i].text.strip()[:1] not in NO_LINE_START]
    if not choices:
        return [phrase]
    total = len(line_text(phrase))
    cut = min(choices, key=lambda i: abs(2 * len(line_text(phrase[:i])) - total))
    return split_balanced(phrase[:cut], fits) + split_balanced(phrase[cut:], fits)


def break_lines(
    words: list[Word], measure, max_width: float, max_seconds: float = 3.5, pause: float = 0.45
) -> list[list[Word]]:
    """One caption line per phrase; long phrases are split evenly by measured width and
    on-screen duration; a one-word scrap is joined to its neighbour when the result fits."""

    def fits(line: list[Word]) -> bool:
        return (
            measure(display_text(line)) <= max_width and line[-1].end - line[0].start <= max_seconds
        )

    lines: list[list[Word]] = []
    for phrase in phrases(words, pause):
        for line in split_balanced(phrase, fits):
            short = len(line) == 1 or len(display_text(line)) <= 3
            previous = lines[-1] if lines else None
            if (
                previous
                and short
                and not SENTENCE_END.search(previous[-1].text.strip())
                and line[0].start - previous[-1].end <= pause
                and fits(previous + line)
            ):
                previous.extend(line)
            else:
                lines.append(line)
    return lines


def wrap_plain(text: str, measure, max_width: float) -> list[str]:
    """Wrap free text (a translation) by width: at spaces for Latin, between jieba words for CJK."""
    if is_cjk(text):
        import jieba

        jieba.setLogLevel(60)
        pieces = list(jieba.cut(text))
    else:
        pieces = re.findall(r"\S+\s*", text)
    lines, current = [], ""
    for piece in pieces:
        if (
            current
            and measure((current + piece).strip()) > max_width
            and piece.strip()[:1] not in NO_LINE_START
        ):
            lines.append(current.strip())
            current = piece
        else:
            current += piece
    if current.strip():
        lines.append(current.strip())
    return lines


class FontMeasure:
    """Width of text as libass draws it: ASS Fontsize is the font's ascent+descent, not its em."""

    def __init__(self, pattern: str, em_px: int, outline: float) -> None:
        from PIL import ImageFont

        path, index = font_file(pattern)
        reference = ImageFont.truetype(path, 1000, index=index)
        ascent, descent = reference.getmetrics()
        self.line_ratio = (ascent + descent) / 1000  # ASS Fontsize per em pixel
        self.font = ImageFont.truetype(path, em_px, index=index)
        self.ass_size = round(em_px * self.line_ratio)
        self.outline = outline

    def __call__(self, text: str) -> float:
        return self.font.getlength(text) + 2 * self.outline


def ts_srt(t: float) -> str:
    ms = round(t * 1000)
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def ts_ass(t: float) -> str:
    cs = round(t * 100)
    return f"{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"


def ass_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("{", "(").replace("}", ")").replace("\n", " ")


def karaoke_text(line: list[Word]) -> str:
    """{\\k} per word; each word lights up when it starts (durations follow word starts, so pauses
    inside a line do not make the highlight drift)."""
    parts = []
    cjk = is_cjk(line_text(line))
    for i, word in enumerate(line):
        last = i + 1 == len(line)
        until = word.end if last else line[i + 1].start
        cs = max(1, round(until * 100) - round(word.start * 100))
        text = TRAILING_SOFT.sub("", word.text) if last and cjk else word.text
        parts.append(f"{{\\k{cs}}}{ass_escape(text)}")
    return "".join(parts).strip()


def ass_header(
    width: int,
    height: int,
    family: str,
    size: int,
    sub_size: int,
    outline: float,
    margin: int,
    margin_v: int,
) -> str:
    style = "Style: {name},{family},{size},{primary},{secondary},&H00000000,{back},{bold},0,0,0,100,100,0,0,{border},{outline},{shadow},2,{m},{m},{mv},1"
    styles = [
        style.format(
            name="Clean",
            family=family,
            size=size,
            primary="&H00FFFFFF",
            secondary="&H00FFFFFF",
            back="&H80000000",
            bold=0,
            border=1,
            outline=outline * 0.6,
            shadow=2,
            m=margin,
            mv=margin_v,
        ),
        style.format(
            name="Karaoke",
            family=family,
            size=size,
            primary=HIGHLIGHT,
            secondary="&H00FFFFFF",
            back="&H80000000",
            bold=-1,
            border=1,
            outline=outline,
            shadow=2,
            m=margin,
            mv=margin_v,
        ),
        style.format(
            name="Main",
            family=family,
            size=size,
            primary="&H00FFFFFF",
            secondary="&H00FFFFFF",
            back="&H80000000",
            bold=-1,
            border=1,
            outline=outline,
            shadow=1,
            m=margin,
            mv=margin_v,
        ),
        style.format(
            name="Sub",
            family=family,
            size=sub_size,
            primary="&H00E6E6E6",
            secondary="&H00FFFFFF",
            back="&H99000000",
            bold=0,
            border=3,
            outline=round(outline * 0.6),
            shadow=0,
            m=margin,
            mv=margin_v,
        ),
    ]
    return "\n".join(
        [
            "[Script Info]",
            "ScriptType: v4.00+",
            f"PlayResX: {width}",
            f"PlayResY: {height}",
            "WrapStyle: 2",
            "ScaledBorderAndShadow: yes",
            "",
            "[V4+ Styles]",
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
            *styles,
            "",
            "[Events]",
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        ]
    )


def load_translations(path: str | None) -> list[str]:
    if not path:
        return []
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return [item if isinstance(item, str) else item.get("translation", "") for item in data]


def build(
    words: list[Word],
    *,
    width: int,
    height: int,
    style: str,
    em_px: int | None = None,
    translations: list[str] | None = None,
    font: str = "Noto Sans CJK SC:bold",
    offset: float = 0.0,
) -> dict:
    """Return {"lines", "srt", "ass", "remotion", "max_px", "limit_px"} for the given words."""
    portrait = height > width
    em_px = em_px or round((width if portrait else height) * (0.065 if portrait else 0.055))
    outline = max(2.0, round(em_px * 0.08))
    # Clean and the translation line are drawn in the regular weight (narrower Latin glyphs).
    regular = re.sub(r":(bold|weight=\w+)", "", font)
    clean = style == "clean"
    measure = FontMeasure(regular if clean else font, em_px, outline * 0.6 if clean else outline)
    limit = width * (0.84 if portrait else 0.8)
    lines = break_lines(group_words(words), measure, limit)
    margin_v = round(height * (0.27 if portrait else 0.08))
    side = max(10, round((width - limit) / 2))
    sub_em = round(em_px * 0.62)
    sub_measure = FontMeasure(regular, sub_em, 0)
    head = ass_header(
        width,
        height,
        font_family(font),
        measure.ass_size,
        sub_measure.ass_size,
        outline,
        side,
        margin_v,
    )
    srt, events, remotion, line_records = [], [head], [], []
    translations = translations or []
    for i, line in enumerate(lines):
        start, end = line[0].start + offset, line[-1].end + offset
        text = display_text(line)
        line_records.append({"start": round(start, 3), "end": round(end, 3), "text": text})
        srt.append(f"{i + 1}\n{ts_srt(start)} --> {ts_srt(end)}\n{text}\n")
        if style == "karaoke":
            shifted = [Word(w.text, w.start + offset, w.end + offset) for w in line]
            events.append(
                f"Dialogue: 0,{ts_ass(start)},{ts_ass(end)},Karaoke,,0,0,0,,{karaoke_text(shifted)}"
            )
        elif style == "bilingual":
            sub_lines = (
                wrap_plain(translations[i], sub_measure, limit) if i < len(translations) else []
            )
            main_margin = margin_v
            if sub_lines:
                sub_text = "\\N".join(ass_escape(part) for part in sub_lines)
                events.append(
                    f"Dialogue: 0,{ts_ass(start)},{ts_ass(end)},Sub,,0,0,{margin_v},,{sub_text}"
                )
                main_margin += round(len(sub_lines) * sub_measure.ass_size * 1.1 + em_px * 0.25)
            events.append(
                f"Dialogue: 1,{ts_ass(start)},{ts_ass(end)},Main,,0,0,{main_margin},,{ass_escape(text)}"
            )
        else:
            events.append(
                f"Dialogue: 0,{ts_ass(start)},{ts_ass(end)},Clean,,0,0,0,,{ass_escape(text)}"
            )
        remotion.append(
            {
                "words": [
                    {
                        "text": w.text.strip(),
                        "start": round(w.start + offset, 3),
                        "end": round(max(w.end, w.start + 0.05) + offset, 3),
                    }
                    for w in line
                    if w.text.strip()
                ]
            }
        )
    return {
        "lines": line_records,
        "srt": "\n".join(srt),
        "ass": "\n".join(events) + "\n",
        "remotion": remotion,
        "max_px": round(max((measure(r["text"]) for r in line_records), default=0)),
        "limit_px": round(limit),
        "em_px": em_px,
    }


def add_parser(sub) -> None:
    p = sub.add_parser("captions", help="word-timed captions (SRT/ASS/Remotion), optional burn-in")
    p.add_argument("input", help="video or audio with speech")
    p.add_argument(
        "-o", "--output", help="output prefix (default <input without extension>.captions)"
    )
    p.add_argument(
        "--style", choices=STYLES, default="karaoke", help="default karaoke (bold, word by word)"
    )
    p.add_argument(
        "--burn", action="store_true", help="also write <prefix>.mp4 with captions burned in"
    )
    p.add_argument(
        "--words", help="reuse a words.json from transcribe/jumpcut instead of running ASR"
    )
    p.add_argument(
        "--translations",
        help="bilingual: JSON list of strings, one per line in <prefix>.lines.json",
    )
    p.add_argument("--size", help="canvas WxH when the input is audio only (default 1080x1920)")
    p.add_argument("--font-size", type=int, help="glyph size in px (default 6.5%% of a 9:16 width)")
    p.add_argument("--font", default="Noto Sans CJK SC:bold", help="fontconfig pattern")
    p.add_argument(
        "--offset", type=float, default=0.0, help="seconds added to every time (VO placed later)"
    )
    p.add_argument("--model", default="turbo", help=MODEL_HELP)
    p.add_argument("--lang", help="language code (default: detect)")
    p.set_defaults(func=main)


def main(args) -> None:
    timer = Timer()
    source = Path(args.input)
    prefix = (
        Path(args.output)
        if args.output
        else source.with_suffix("").with_name(source.stem + ".captions")
    )
    prefix.parent.mkdir(parents=True, exist_ok=True)
    info = probe(source)
    if info.has_video:
        width, height = info.width, info.height
    else:
        width, height = (int(x) for x in (args.size or "1080x1920").lower().split("x"))
    if args.burn and not info.has_video:
        raise SystemExit("--burn needs a video input")
    if args.style == "bilingual" and not args.translations:
        log(
            "bilingual without --translations: run once, translate <prefix>.lines.json, then rerun with --translations"
        )
    data = load_or_transcribe(
        str(source), args.words, args.model, args.lang, Path(f"{prefix}.words.json")
    )
    words = [Word(w["word"], w["start"], w["end"]) for w in flat_words(data)]
    if not words:
        raise SystemExit("no speech found")
    built = build(
        words,
        width=width,
        height=height,
        style=args.style,
        em_px=args.font_size,
        translations=load_translations(args.translations),
        font=args.font,
        offset=args.offset,
    )
    outputs = {}
    for ext, content in (("srt", built["srt"]), ("ass", built["ass"])):
        path = Path(f"{prefix}.{ext}")
        path.write_text(content, encoding="utf-8")
        outputs[ext] = str(path)
    for name, content in (("lines", built["lines"]), ("remotion", built["remotion"])):
        path = Path(f"{prefix}.{name}.json")
        path.write_text(json.dumps(content, ensure_ascii=False, indent=1), encoding="utf-8")
        outputs[name] = str(path)
    if args.burn:
        video = Path(f"{prefix}.mp4")
        audio = ["-c:a", "copy"] if info.has_audio else []
        ass_path = outputs["ass"].replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
        ffmpeg(
            "-i",
            str(source),
            "-vf",
            f"ass='{ass_path}'",
            *X264,
            *audio,
            "-movflags",
            "+faststart",
            str(video),
        )
        outputs["video"] = str(video)
    emit(
        {
            **outputs,
            "language": data.get("language"),
            "lines": len(built["lines"]),
            "max_line_px": built["max_px"],
            "limit_px": built["limit_px"],
            "seconds": timer.seconds(),
            "first_lines": [line["text"] for line in built["lines"][:5]],
        }
    )
