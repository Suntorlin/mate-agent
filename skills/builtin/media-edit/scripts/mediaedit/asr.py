"""media-edit transcribe: speech to text with word timestamps (faster-whisper, CPU int8).

Writes words.json: {"language", "duration", "model", "segments": [{"start", "end", "text",
"words": [{"word", "start", "end", "probability"}]}]}. captions and jumpcut read this format.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from .common import MODELS, Timer, emit, log, read_audio

# Without it Whisper often writes Chinese in traditional characters and drops clauses.
ZH_PROMPT = "以下是普通话的句子，使用简体中文。"  # noqa: RUF001
MODEL_DIRS = {"turbo": "large-v3-turbo", "large-v3-turbo": "large-v3-turbo", "small": "small"}


def model_path(name: str) -> str:
    local = MODELS / "whisper" / MODEL_DIRS.get(name, name)
    return str(local) if local.is_dir() else name  # unknown names download from Hugging Face


def transcribe(path: str | Path, model: str = "turbo", language: str | None = None) -> dict:
    from faster_whisper import WhisperModel

    audio = read_audio(path)
    whisper = WhisperModel(
        model_path(model), device="cpu", compute_type="int8", cpu_threads=os.cpu_count() or 4
    )
    if not language:
        language, probability, _ = whisper.detect_language(audio)
        log(f"detected language {language} ({probability:.2f})")
    segments, info = whisper.transcribe(
        audio,
        language=language,
        word_timestamps=True,
        vad_filter=True,
        beam_size=5,
        initial_prompt=ZH_PROMPT if language == "zh" else None,
    )
    result = []
    for segment in segments:
        words = [
            {
                "word": word.word,
                "start": round(word.start, 3),
                "end": round(word.end, 3),
                "probability": round(word.probability, 3),
            }
            for word in segment.words or []
        ]
        result.append(
            {
                "start": round(segment.start, 3),
                "end": round(segment.end, 3),
                "text": segment.text,
                "words": words,
            }
        )
    return {
        "language": info.language,
        "duration": info.duration,
        "model": model,
        "segments": result,
    }


def flat_words(data: dict) -> list[dict]:
    """All non-empty words in order."""
    return [w for s in data["segments"] for w in s["words"] if w["word"].strip()]


def load_or_transcribe(
    media: str, words_path: str | None, model: str, language: str | None, save_to: Path
) -> dict:
    """Reuse a words.json when given, otherwise transcribe and save it next to the output."""
    if words_path:
        return json.loads(Path(words_path).read_text(encoding="utf-8"))
    timer = Timer()
    data = transcribe(media, model, language)
    save_to.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"transcribed {data['duration']:.1f}s with {model} in {timer.seconds()}s -> {save_to}")
    return data


MODEL_HELP = "turbo (default, best for Chinese) or small (fast)"


def add_parser(sub) -> None:
    p = sub.add_parser("transcribe", help="speech to text with word timestamps")
    p.add_argument("input", help="audio or video file")
    p.add_argument("-o", "--output", help="words.json path (default <input>.words.json)")
    p.add_argument("--model", default="turbo", help=MODEL_HELP)
    p.add_argument("--lang", help="language code such as en, zh, ko (default: detect)")
    p.set_defaults(func=main)


def main(args) -> None:
    out = Path(args.output or f"{args.input}.words.json")
    timer = Timer()
    data = transcribe(args.input, args.model, args.lang)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    words = flat_words(data)
    emit(
        {
            "output": str(out),
            "language": data["language"],
            "audio_s": round(data["duration"], 1),
            "words": len(words),
            "model": data["model"],
            **({"credits": data["credits_charged"]} if data.get("credits_charged") else {}),
            "seconds": timer.seconds(),
            "text": "".join(s["text"] for s in data["segments"])[:300],
        }
    )
