"""Black-box tests for the preview skill's `media-export` command."""

import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

MEDIA_EXPORT = Path(__file__).resolve().parents[2] / "skills/builtin/preview/scripts/media-export"

# Stand-in on PATH: upload-media records its arguments and keeps a copy of the zip it was given.
FAKE_UPLOAD_MEDIA = """#!/bin/sh
printf '%s\\n' "$@" > "$UPLOAD_ARGS"
cp "$1" "$UPLOAD_COPY"
echo '{"artifactId": "z1"}'
"""


class MediaExportTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        bin_dir = self.dir / "bin"
        bin_dir.mkdir()
        (bin_dir / "upload-media").write_text(FAKE_UPLOAD_MEDIA)
        (bin_dir / "upload-media").chmod(0o755)
        self.args_file = self.dir / "args.txt"
        self.copy = self.dir / "uploaded.zip"
        self.env = {
            **os.environ,
            "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
            "UPLOAD_ARGS": str(self.args_file),
            "UPLOAD_COPY": str(self.copy),
        }
        self.project = self.dir / "project"
        files = {
            "progress.md": "stage 7",
            "timeline.json": "{}",
            "captions/zh.srt": "1\n00:00:00,000 --> 00:00:01,000\n你好\n",
            "assets/vo_01.mp3": "mp3",
            "renders/v02.mp4": "mp4",
            "handoff/edit.fcpxml": "<fcpxml/>",
            "edit/node_modules/react/index.js": "dependency",
            "edit/.cache/bundle.js": "cache",
            ".git/HEAD": "ref",
        }
        for name, text in files.items():
            path = self.project / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)

    def tearDown(self):
        self._tmp.cleanup()

    def run_cli(self, *args, cwd=None):
        return subprocess.run(
            [sys.executable, str(MEDIA_EXPORT), *map(str, args)],
            capture_output=True,
            text=True,
            env=self.env,
            cwd=cwd,
        )

    def test_bundles_the_project_and_hands_it_over_as_a_project_download(self):
        result = self.run_cli(self.project, "北汉山 工程")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('"artifactId": "z1"', result.stdout)
        args = self.args_file.read_text().splitlines()
        self.assertRegex(Path(args[0]).name, r"^project-\d{8}-\d{4}\.zip$")
        self.assertEqual(
            args[1:],
            ["--artifact-type", "file", "--kind", "project", "--caption", "北汉山 工程"],
        )
        with zipfile.ZipFile(self.copy) as bundle:
            names = sorted(bundle.namelist())
            self.assertEqual(
                names,
                [
                    "project/assets/vo_01.mp3",
                    "project/captions/zh.srt",
                    "project/handoff/edit.fcpxml",
                    "project/progress.md",
                    "project/renders/v02.mp4",
                    "project/timeline.json",
                ],
            )
            self.assertEqual(
                bundle.getinfo("project/renders/v02.mp4").compress_type, zipfile.ZIP_STORED
            )
            self.assertEqual(
                bundle.getinfo("project/timeline.json").compress_type, zipfile.ZIP_DEFLATED
            )
            self.assertEqual(
                bundle.read("project/captions/zh.srt").decode(),
                "1\n00:00:00,000 --> 00:00:01,000\n你好\n",
            )
        # The zip is gone from the sandbox once handed over.
        self.assertFalse(Path(args[0]).exists())

    def test_defaults_to_the_current_folder_and_its_name(self):
        result = self.run_cli(cwd=self.project)
        self.assertEqual(result.returncode, 0, result.stderr)
        args = self.args_file.read_text().splitlines()
        self.assertEqual(args[-1], "project")

    def test_refuses_an_empty_or_missing_folder(self):
        empty = self.dir / "empty"
        empty.mkdir()
        result = self.run_cli(empty, "x")
        self.assertEqual(result.returncode, 1)
        self.assertIn("no files", result.stderr)
        self.assertEqual(self.run_cli(self.dir / "missing", "x").returncode, 1)
        self.assertFalse(self.args_file.exists())


if __name__ == "__main__":
    unittest.main()
