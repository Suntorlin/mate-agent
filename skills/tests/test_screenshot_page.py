"""Black-box tests for viral-remake's `screenshot_page.sh`: agent-browser, always time-boxed."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "skills/builtin/viral-remake/scripts/screenshot_page.sh"

# Stand-ins on PATH. `timeout` logs its arguments and either runs the command or, when the
# agent-browser step named in $FAKE_EXPIRE_STEP comes up, reports that it had to kill it;
# `agent-browser` logs each call and writes the screenshot unless $FAKE_NO_OUTPUT is set.
FAKE_TIMEOUT = """#!/bin/sh
printf '%s\\n' "$*" >> "$TIMEOUT_LOG"
shift 3
[ -n "$FAKE_EXPIRE_STEP" ] && [ "$4" = "$FAKE_EXPIRE_STEP" ] && exit 124
exec "$@"
"""
FAKE_AGENT_BROWSER = """#!/bin/sh
printf '%s\\n' "$*" >> "$BROWSER_LOG"
if [ "$3" = "screenshot" ] && [ -z "$FAKE_NO_OUTPUT" ]; then
  printf 'png' > "$5"
fi
"""


class ScreenshotPageTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        bin_dir = self.dir / "bin"
        bin_dir.mkdir()
        for name, body in (("timeout", FAKE_TIMEOUT), ("agent-browser", FAKE_AGENT_BROWSER)):
            (bin_dir / name).write_text(body)
            (bin_dir / name).chmod(0o755)
        self.timeout_log = self.dir / "timeout.txt"
        self.browser_log = self.dir / "browser.txt"
        self.env = {
            **os.environ,
            "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
            "TIMEOUT_LOG": str(self.timeout_log),
            "BROWSER_LOG": str(self.browser_log),
        }
        (self.dir / "storyboard.html").write_text("<html></html>")

    def tearDown(self):
        self._tmp.cleanup()

    def run_script(self, *args, **env):
        return subprocess.run(
            ["bash", str(SCRIPT), *args],
            capture_output=True,
            text=True,
            cwd=self.dir,
            env={**self.env, **env},
            timeout=30,
        )

    def browser_calls(self):
        return [line.split(" ", 2)[2] for line in self.browser_log.read_text().splitlines()]

    def test_sets_the_viewport_opens_the_page_and_captures_it_in_one_session(self):
        result = self.run_script("storyboard.html", "renders/sb.png", "1080", "1920")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "renders/sb.png")
        self.assertEqual((self.dir / "renders/sb.png").read_bytes(), b"png")
        self.assertEqual(
            self.browser_calls(),
            [
                "set viewport 1080 1920",
                f"open file://{self.dir.resolve()}/storyboard.html",
                f"screenshot --full {self.dir.resolve()}/renders/sb.png",
                "close",
            ],
        )
        sessions = {line.split(" ")[1] for line in self.browser_log.read_text().splitlines()}
        self.assertEqual(len(sessions), 1)
        # Every browser step runs under the hard timeout, including the final close.
        self.assertTrue(all(line.startswith("-k 5 ") for line in self.timeout_log.read_text().splitlines()))

    def test_the_timeout_is_configurable(self):
        result = self.run_script("storyboard.html", "sb.png", SCREENSHOT_TIMEOUT_SECONDS="20")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.timeout_log.read_text().splitlines()[0].startswith("-k 5 20 "))

    def test_a_hung_step_is_reported_not_waited_on_and_the_session_closed(self):
        result = self.run_script("storyboard.html", "sb.png", FAKE_EXPIRE_STEP="open")
        self.assertEqual(result.returncode, 124)
        self.assertIn("did not finish 'open' within 60s", result.stderr)
        self.assertEqual(self.browser_calls()[-1], "close")

    def test_no_screenshot_is_a_failure(self):
        result = self.run_script("storyboard.html", "sb.png", FAKE_NO_OUTPUT="1")
        self.assertEqual(result.returncode, 1)
        self.assertIn("without writing", result.stderr)


if __name__ == "__main__":
    unittest.main()
