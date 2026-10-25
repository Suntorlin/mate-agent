"""language-hook: keep the agent's own lines in the language the user types in (stdlib only).

  language-hook prompt   UserPromptSubmit hook: reads the hook's JSON on stdin, prints this turn's
                         language rule naming the user's language, and saves the short reminder
                         the PostToolUse hook (a plain ``cat``) prints after every tool call

Deep in a turn, users who write in Chinese still got English progress lines: the agent thinks in
English, and the line it writes for the user right after reads as a continuation of that thinking
("Five lines are done. Next I'm downloading them…"), or of an English tool error ("I'll just use
the TTS tool directly."). A reminder written in the user's own language right after each tool
result sits where that line is written.

Platform-written messages (attached-file notes, answer cards) and messages too short to tell keep
the language already saved. Quoted text is material ("台词是「Hello, I am your voice」"), not the
user's language. bin/language-hook runs this file directly, so it imports nothing from the
package, and the hook never fails a session.
"""

# ruff: noqa: RUF001 (the reminders are Chinese, Japanese and Korean text)
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import TYPE_CHECKING, TextIO

if TYPE_CHECKING:
    from collections.abc import Mapping

LANGUAGE_FILE = "language"
TOOL_REMINDER_FILE = "language-reminder.json"
DEFAULT_CONFIG_DIR = ".openinspect/claude"

GENERIC = "other"
TURN_REMINDERS = {
    "zh": (
        "本轮语言：用户用中文跟你对话。用户能看到的每一句话都用中文写：工具调用之间的每句进度说明、"
        "每个 Bash 调用或子代理的 description（界面上的步骤名）、计划、提问和最后的交付说明。"
        "技能文档、代码、工具输出、你正在做的素材（比如英文、日文台词或字幕）或你自己的思考是英文"
        "或其它语言时，也不要跟着切换；给用户的话不是思考的延续，从第一个字起就用中文。"
        "工作被平台打断（比如额度上限）后用户说「继续」时也一样。代码、命令、文件名和引用的原文保持原样。"
        "用户明确要求你换一种语言回复时才换。"
    ),
    "ja": (
        "このターンの言語：ユーザーは日本語で話しています。ユーザーに見える文はすべて日本語で書くこと："
        "ツール呼び出しの合間の進捗の一言、各 Bash 呼び出しやサブエージェントの description（画面上の"
        "ステップ名）、計画、質問、最後の納品の説明。スキル文書、コード、ツール出力、制作中の素材"
        "（英語や中国語のセリフ・字幕など）、あなた自身の思考が英語や他の言語でも切り替えないこと。"
        "ユーザーへの文は思考の続きではなく、最初の一語から日本語で書く。上限などで中断された後の再開でも"
        "同じ。コード、コマンド、ファイル名、"
        "引用した原文はそのまま。ユーザーが別の言語での返答を明示的に求めた場合のみ切り替える。"
    ),
    "ko": (
        "이번 턴의 언어: 사용자는 한국어로 대화합니다. 사용자에게 보이는 모든 문장을 한국어로 쓰세요: "
        "도구 호출 사이의 진행 상황 한 줄, 각 Bash 호출이나 서브에이전트의 description(화면의 단계 "
        "이름), 계획, 질문, 마지막 전달 설명. 스킬 문서, 코드, 도구 출력, 만들고 있는 소재(영어·일본어 "
        "대사나 자막 등), 또는 당신 자신의 생각이 영어나 다른 언어여도 바꾸지 마세요. 사용자에게 쓰는 "
        "문장은 생각의 연장이 아니므로 첫 단어부터 한국어로 씁니다. 한도 등으로 중단된 뒤 다시 이어갈 "
        "때도 같습니다. 코드, 명령어, 파일 이름, 인용한 "
        "원문은 그대로 둡니다. 사용자가 다른 언어로 답해 달라고 분명히 요청할 때만 바꿉니다."
    ),
    GENERIC: (
        "Language for this turn: write every line the user sees, including each short progress "
        "line between tool calls and the description of each Bash call or subagent, plans, "
        "questions and the final answer, in the language of the user's own message this turn. "
        "Do not switch because a skill, code, tool output, the material you are making (voice "
        "lines or captions in other languages) or your own thinking is in English or another "
        "language: a line for the user is not a continuation of your thinking. The same holds when "
        "work resumes after the platform paused it (a cost limit). Switch only when "
        "the user asks you to answer in another language."
    ),
}
TOOL_REMINDERS = {
    "zh": (
        "（语言提醒：用户用中文。接下来给用户看的进度说明和 Bash/子代理的 description 继续用中文，"
        "不随工具输出、素材或你思考的语言切换。）"
    ),
    "ja": (
        "（言語の注意：ユーザーは日本語です。次にユーザーに見せる進捗の一言と Bash／サブエージェントの "
        "description も日本語で。ツール出力・素材・自分の思考の言語に合わせて切り替えないこと。）"
    ),
    "ko": (
        "(언어 알림: 사용자는 한국어를 씁니다. 다음에 사용자에게 보여 줄 진행 상황 한 줄과 "
        "Bash/서브에이전트 description도 한국어로 쓰고, 도구 출력·소재·당신의 생각의 언어를 따라 "
        "바꾸지 마세요.)"
    ),
    GENERIC: (
        "(Language reminder: the next line the user sees, and each Bash or subagent description, "
        "stays in the language the user types their own messages in, whatever language this "
        "output, the material or your thinking is in.)"
    ),
}

HAN = re.compile(r"[㐀-䶿一-鿿豈-﫿]")
KANA = re.compile(r"[぀-ヿㇰ-ㇿ]")
HANGUL = re.compile(r"[ᄀ-ᇿ㄰-㆏가-힯]")
LATIN_WORD = re.compile(r"[A-Za-zÀ-ɏ]+")
URL = re.compile(r"\S+://\S+")
CODE = re.compile(r"```.*?```|`[^`\n]*`", re.DOTALL)
QUOTED = re.compile(r"「[^」]*」|『[^』]*』|“[^”]*”|\"[^\"\n]*\"|《[^》]*》")
# Whole lines the platform writes: "[Files the user attached are ready: …]", "[用户点了…]".
PLATFORM_LINE = re.compile(r"^\[[^\n]*\]$", re.MULTILINE)
# Answers and closed or clicked question cards: their words are option labels the agent wrote.
PLATFORM_MESSAGE = re.compile(r"^\s*\[(?:回答 |用户点了|用户关闭了问题)")
# Fewer letters than this outside CJK say nothing ("ok", "v2", "👍").
MIN_LETTERS = 8


def detect_language(message: str) -> str | None:
    """``zh``, ``ja``, ``ko``, ``other`` (another script or language), or ``None`` (cannot tell)."""
    if PLATFORM_MESSAGE.match(message):
        return None
    text = PLATFORM_LINE.sub(" ", CODE.sub(" ", URL.sub(" ", message)))
    unquoted = QUOTED.sub(" ", text)
    if any(ch.isalpha() for ch in unquoted):
        text = unquoted
    han, kana, hangul = (len(pattern.findall(text)) for pattern in (HAN, KANA, HANGUL))
    cjk = han + kana + hangul
    if cjk and cjk >= 2 * len(LATIN_WORD.findall(text)):
        if 2 * hangul >= cjk:
            return "ko"
        if 5 * kana >= han + kana:
            return "ja"
        return "zh"
    letters = sum(ch.isalpha() for ch in text)
    return GENERIC if letters >= MIN_LETTERS else None


def config_dir(environ: Mapping[str, str]) -> Path:
    return Path(environ.get("CLAUDE_CONFIG_DIR") or Path.home() / DEFAULT_CONFIG_DIR)


def tool_hook_output(language: str) -> str:
    """What the PostToolUse hook prints: JSON whose additionalContext follows the tool result."""
    context = TOOL_REMINDERS.get(language, TOOL_REMINDERS[GENERIC])
    output = {"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": context}}
    return json.dumps(output, ensure_ascii=False) + "\n"


def _write(path: Path, text: str) -> None:
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(path)


def remember(directory: Path, language: str) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    _write(directory / TOOL_REMINDER_FILE, tool_hook_output(language))
    _write(directory / LANGUAGE_FILE, language + "\n")


def remembered(directory: Path) -> str:
    try:
        language = (directory / LANGUAGE_FILE).read_text(encoding="utf-8").strip()
    except OSError:
        return GENERIC
    return language if language in TURN_REMINDERS else GENERIC


def hook_prompt(stdin: TextIO) -> str:
    """The user's message in a UserPromptSubmit hook's JSON input, or "" without one."""
    if stdin.isatty():
        return ""
    try:
        payload = json.loads(stdin.read() or "{}")
    except ValueError:
        return ""
    prompt = payload.get("prompt") if isinstance(payload, dict) else None
    return prompt if isinstance(prompt, str) else ""


def cmd_prompt(environ: Mapping[str, str], stdin: TextIO, stdout: TextIO) -> int:
    language = GENERIC
    try:
        directory = config_dir(environ)
        detected = detect_language(hook_prompt(stdin))
        if detected is None:
            language = remembered(directory)
        else:
            language = detected
            remember(directory, language)
    except (OSError, ValueError) as error:
        print(f"language-hook: {error}", file=sys.stderr)
    stdout.write(TURN_REMINDERS[language] + "\n")
    return 0


def main(argv: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if argv is None else argv
    if arguments[:1] == ["prompt"]:
        return cmd_prompt(os.environ, sys.stdin, sys.stdout)
    print("usage: language-hook prompt  (a UserPromptSubmit hook; JSON on stdin)", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
