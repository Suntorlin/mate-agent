# ruff: noqa: RUF001 (Chinese, Japanese and Korean messages)
import io
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from sandbox_runtime import language as language_module
from sandbox_runtime.claude_settings import LANGUAGE_TOOL_COMMAND
from sandbox_runtime.language import (
    GENERIC,
    LANGUAGE_FILE,
    TOOL_REMINDER_FILE,
    TOOL_REMINDERS,
    TURN_REMINDERS,
    cmd_prompt,
    detect_language,
    tool_hook_output,
)

MODULE_FILE = Path(language_module.__file__)
BIN_FILE = MODULE_FILE.parent / "bin" / "language-hook"

# The prompts of the two sessions where English progress lines came back (2026-10-08).
FIVE_LANGUAGES = (
    "用动效设计技能做一条 20 秒、9:16 的「一个声音，说 5 种语言」动态文字片：\n"
    "1. 同一句「你好，我是你的声音」，用同一个中文女声音色依次说中文、英文、日文、韩文、"
    "西班牙语，每句约 3 秒；\n"
    "3. 背景是一组随人声波形实时跳动的抽象图形（用 Lottie 或程序绘制），每种语言一个配色；\n"
    "4. 结尾定版「Acme Voice · 一个声音，全世界听懂」，光扫过。"
)
TALKING_BEAR = (
    "用会说话的角色技能做一条 20 秒左右的竖屏短剧：一只戴小厨师帽的毛绒小熊是面包店店员，"
    "它对着镜头介绍今天的新品「蜂蜜黄油可颂」。选便宜的档位，不用问我，直接做。"
)


def hook_input(prompt: str) -> io.StringIO:
    return io.StringIO(json.dumps({"hook_event_name": "UserPromptSubmit", "prompt": prompt}))


@pytest.mark.parametrize(
    ("message", "language"),
    [
        (FIVE_LANGUAGES, "zh"),
        (TALKING_BEAR, "zh"),
        ("继续。", "zh"),
        ("用 Remotion 做一个产品动画", "zh"),
        ("把这句配成日语：「こんにちは、私はあなたの声です」", "zh"),
        ('台词是 "Hello, I am your voice"，配上字幕', "zh"),
        ("把 https://www.youtube.com/watch?v=abcdef 这个视频翻拍一下", "zh"),
        ("猫のカフェの動画を作ってください。明るい感じで。", "ja"),
        ("고양이 카페 영상을 만들어 주세요. 밝은 느낌으로요.", "ko"),
        ("Make a 20 second video of a talking bear in a bakery.", GENERIC),
        ("Haz un video de 20 segundos con un oso que habla.", GENERIC),
        ('Make a video where the bear says "你好，明天见"', GENERIC),
        ("Сделай видео про кота в кафе", GENERIC),
    ],
)
def test_detects_the_language_the_user_types_in(message: str, language: str) -> None:
    assert detect_language(message) == language


@pytest.mark.parametrize(
    "message",
    [
        "ok",
        "v2",
        "👍",
        "",
        "[回答 q-1] Option A: warm grade",
        "[用户点了「Skip」，问题 q-2]",
        "[用户关闭了问题 q-3，没有回答，请按你的判断继续]",
        "[Files the user attached are ready: /workspace/uploads/a.png]",
    ],
)
def test_platform_notes_and_short_replies_say_nothing_about_the_language(message: str) -> None:
    assert detect_language(message) is None


def test_reminders_exist_for_every_language_and_name_it() -> None:
    assert set(TURN_REMINDERS) == set(TOOL_REMINDERS) == {"zh", "ja", "ko", GENERIC}
    assert "用户用中文" in TURN_REMINDERS["zh"]
    assert "用户用中文" in TOOL_REMINDERS["zh"]
    assert "日本語" in TOOL_REMINDERS["ja"]
    assert "한국어" in TOOL_REMINDERS["ko"]
    for reminders in (TURN_REMINDERS, TOOL_REMINDERS):
        for text in reminders.values():
            assert "description" in text
    assert "思考" in TURN_REMINDERS["zh"]
    assert "素材" in TURN_REMINDERS["zh"]
    assert "progress line" in TURN_REMINDERS[GENERIC]
    assert "description of each Bash call or subagent" in TURN_REMINDERS[GENERIC]
    assert "user's own message this turn" in TURN_REMINDERS[GENERIC]
    assert "your own thinking" in TURN_REMINDERS[GENERIC]
    assert "额度上限" in TURN_REMINDERS["zh"]
    assert "a cost limit" in TURN_REMINDERS[GENERIC]


def test_tool_hook_output_is_post_tool_use_additional_context() -> None:
    output = json.loads(tool_hook_output("zh"))
    assert output == {
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": TOOL_REMINDERS["zh"],
        }
    }


def test_prompt_prints_the_rule_in_the_users_language_and_saves_the_tool_reminder(
    tmp_path: Path,
) -> None:
    out = io.StringIO()
    assert cmd_prompt({"CLAUDE_CONFIG_DIR": str(tmp_path)}, hook_input(FIVE_LANGUAGES), out) == 0
    assert out.getvalue() == TURN_REMINDERS["zh"] + "\n"
    assert (tmp_path / LANGUAGE_FILE).read_text() == "zh\n"
    assert (tmp_path / TOOL_REMINDER_FILE).read_text() == tool_hook_output("zh")


def test_answer_cards_keep_the_language_the_creator_typed_in(tmp_path: Path) -> None:
    env = {"CLAUDE_CONFIG_DIR": str(tmp_path)}
    cmd_prompt(env, hook_input(TALKING_BEAR), io.StringIO())
    out = io.StringIO()
    cmd_prompt(env, hook_input("[回答 q-1] Warm grade, 720p"), out)
    assert out.getvalue() == TURN_REMINDERS["zh"] + "\n"
    assert (tmp_path / TOOL_REMINDER_FILE).read_text() == tool_hook_output("zh")


def test_a_creator_who_switches_language_gets_the_new_one(tmp_path: Path) -> None:
    env = {"CLAUDE_CONFIG_DIR": str(tmp_path)}
    cmd_prompt(env, hook_input(TALKING_BEAR), io.StringIO())
    out = io.StringIO()
    cmd_prompt(env, hook_input("Now make an English version of the same film, please."), out)
    assert out.getvalue() == TURN_REMINDERS[GENERIC] + "\n"
    assert (tmp_path / TOOL_REMINDER_FILE).read_text() == tool_hook_output(GENERIC)


def test_prompt_never_fails_the_session(tmp_path: Path) -> None:
    blocked = tmp_path / "file"
    blocked.write_text("")
    out = io.StringIO()
    # The config dir is a file, so nothing can be saved: the rule is still printed.
    assert cmd_prompt({"CLAUDE_CONFIG_DIR": str(blocked)}, hook_input(TALKING_BEAR), out) == 0
    assert out.getvalue() == TURN_REMINDERS["zh"] + "\n"
    out = io.StringIO()
    assert cmd_prompt({"CLAUDE_CONFIG_DIR": str(tmp_path)}, io.StringIO("not json"), out) == 0
    assert out.getvalue() == TURN_REMINDERS[GENERIC] + "\n"


def test_hooks_end_to_end_as_the_sandbox_runs_them(tmp_path: Path) -> None:
    """The prompt hook runs the file directly (as bin/language-hook does); the tool hook cats."""
    env = {**os.environ, "CLAUDE_CONFIG_DIR": str(tmp_path), "PYTHONSAFEPATH": "1"}
    prompt = subprocess.run(
        [sys.executable, str(MODULE_FILE), "prompt"],
        input=json.dumps({"prompt": FIVE_LANGUAGES}),
        capture_output=True,
        text=True,
        env=env,
        check=True,
    )
    assert prompt.stdout == TURN_REMINDERS["zh"] + "\n"
    tool = subprocess.run(
        LANGUAGE_TOOL_COMMAND, shell=True, capture_output=True, text=True, env=env, check=True
    )
    context = json.loads(tool.stdout)["hookSpecificOutput"]["additionalContext"]
    assert context == TOOL_REMINDERS["zh"]


def test_bin_wrapper_runs_this_file() -> None:
    text = BIN_FILE.read_text()
    assert "/app/sandbox_runtime/language.py" in text
    assert "PYTHONSAFEPATH=1" in text
    assert os.access(BIN_FILE, os.X_OK)
