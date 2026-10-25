"""Argument parsing for `media-edit <command>`; each command module adds its own subparser."""

from __future__ import annotations

import argparse

from . import (
    asr,
    beatcut,
    captions,
    contact,
    fxcaptions,
    grade,
    jumpcut,
    loudness,
    reframe,
    scenes,
    voice,
)

COMMANDS = (
    asr,
    captions,
    fxcaptions,
    jumpcut,
    reframe,
    beatcut,
    voice,
    grade,
    loudness,
    scenes,
    contact,
)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(
        prog="media-edit",
        description="Editing commands; each prints a JSON summary on stdout, progress on stderr.",
    )
    sub = root.add_subparsers(dest="command", required=True, metavar="<command>")
    for module in COMMANDS:
        module.add_parser(sub)
    return root


def main(argv: list[str] | None = None) -> None:
    args = parser().parse_args(argv)
    args.func(args)
