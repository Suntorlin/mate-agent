"""Black-box tests for the preview skill's `media-preview` command."""

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

MEDIA_PREVIEW = Path(__file__).resolve().parents[2] / "skills/builtin/preview/scripts/media-preview"

# Stand-ins on PATH: upload-media records its arguments (and appends one JSON line per call to
# $UPLOAD_LOG, failing for a file named in $FAIL_UPLOAD) and prints indented JSON like the real
# one, a new artifactId per call (a1, a2, ...); ffprobe prints $FAKE_PROBE.
FAKE_UPLOAD_MEDIA = """#!/bin/sh
printf '%s\\n' "$@" > "$UPLOAD_ARGS"
python3 -c 'import json, sys; print(json.dumps(sys.argv[1:]))' "$@" >> "$UPLOAD_LOG"
[ "$1" = "$FAIL_UPLOAD" ] && exit 1
n=$(wc -l < "$UPLOAD_LOG" | tr -d ' ')
printf '{\\n  "artifactId": "a%s",\\n  "objectKey": "sessions/s/media/a%s"\\n}\\n' "$n" "$n"
"""
# What the agent in session 88b7ecd1 counted its publishes with.
ARTIFACT_ID_GREP = re.compile(r'"artifactId":"[^"]*"')
FAKE_FFPROBE = """#!/bin/sh
printf '%s' "$FAKE_PROBE"
"""


def probe(codec="h264", duration="15.016", audio=True):
    streams = [{"codec_type": "video", "codec_name": codec, "width": 720, "height": 1280}]
    if audio:
        streams.append({"codec_type": "audio", "codec_name": "aac"})
    return json.dumps({"streams": streams, "format": {"duration": duration}})


class MediaPreviewTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        bin_dir = self.dir / "bin"
        bin_dir.mkdir()
        for name, body in (("upload-media", FAKE_UPLOAD_MEDIA), ("ffprobe", FAKE_FFPROBE)):
            (bin_dir / name).write_text(body)
            (bin_dir / name).chmod(0o755)
        self.args_file = self.dir / "args.txt"
        self.env = {
            **os.environ,
            "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
            "UPLOAD_ARGS": str(self.args_file),
            "UPLOAD_LOG": str(self.dir / "uploads.jsonl"),
            "FAKE_PROBE": probe(),
            "MEDIA_PREVIEW_LEDGER": str(self.dir / "published.json"),
            "SESSION_CONFIG": json.dumps({"sessionId": "s1"}),
        }

    def tearDown(self):
        self._tmp.cleanup()

    def file(self, name, data=b"x"):
        path = self.dir / name
        path.write_bytes(data)
        return path

    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, str(MEDIA_PREVIEW), *map(str, args)],
            capture_output=True,
            text=True,
            env=self.env,
        )

    def uploaded(self):
        return self.args_file.read_text().splitlines()

    def uploads(self):
        log = self.dir / "uploads.jsonl"
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

    def results(self, result):
        """The JSON line printed for each pair."""
        return [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]

    def summary(self, result):
        return result.stdout.splitlines()[-1]

    def flag(self, name):
        args = self.uploaded()
        return args[args.index(name) + 1]

    def test_video_carries_what_ffprobe_reads(self):
        video = self.file("final.mp4")
        result = self.run_cli(video, "成片")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            self.results(result),
            [{"artifactId": "a1", "objectKey": "sessions/s/media/a1", "title": "成片"}],
        )
        self.assertEqual(self.summary(result), "published 1/1: 成片")
        self.assertEqual(self.uploaded()[0], str(video))
        self.assertEqual(self.flag("--artifact-type"), "video")
        self.assertEqual(self.flag("--caption"), "成片")
        self.assertEqual(self.flag("--duration-ms"), "15016")
        self.assertEqual(json.loads(self.flag("--dimensions")), {"width": 720, "height": 1280})
        self.assertEqual(self.flag("--has-audio"), "true")
        self.assertEqual(self.flag("--truncated"), "false")
        span = int(self.flag("--recording-ended-at")) - int(self.flag("--recording-started-at"))
        self.assertEqual(span, 15016)

    def test_silent_video(self):
        self.env["FAKE_PROBE"] = probe(audio=False)
        self.assertEqual(self.run_cli(self.file("cut.mp4"), "Cut").returncode, 0)
        self.assertEqual(self.flag("--has-audio"), "false")

    def test_refuses_previews_the_browser_cannot_play_and_points_to_a_download(self):
        self.env["FAKE_PROBE"] = probe(codec="hevc")
        result = self.run_cli(self.file("cut.mp4"), "Cut")
        self.assertEqual(result.returncode, 1)
        self.assertIn("libx264", result.stderr)
        self.assertIn("media-preview --file", result.stderr)

        self.env["FAKE_PROBE"] = probe(duration="600.5")
        result = self.run_cli(self.file("long.mp4"), "Long")
        self.assertEqual(result.returncode, 1)
        self.assertIn("600000 ms", result.stderr)
        self.assertIn("media-preview --file", result.stderr)
        self.assertFalse(self.args_file.exists())

    def test_plays_a_three_minute_4k_preview(self):
        self.env["FAKE_PROBE"] = json.dumps(
            {
                "streams": [
                    {"codec_type": "video", "codec_name": "h264", "width": 2160, "height": 3840},
                    {"codec_type": "audio", "codec_name": "aac"},
                ],
                "format": {"duration": "180.0"},
            }
        )
        result = self.run_cli(self.file("v03-4k.mp4"), "成片 4K")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.flag("--duration-ms"), "180000")
        self.assertEqual(json.loads(self.flag("--dimensions")), {"width": 2160, "height": 3840})

    def test_image_and_page(self):
        self.assertEqual(self.run_cli(self.file("board.png"), "Keyframes").returncode, 0)
        self.assertEqual(self.uploaded()[1:], ["--caption", "Keyframes"])

        page = self.file("storyboard.html", b"<!doctype html><h1>Storyboard</h1>")
        self.assertEqual(self.run_cli(page, "Storyboard").returncode, 0)
        self.assertEqual(
            self.uploaded()[1:], ["--artifact-type", "page", "--caption", "Storyboard"]
        )

    def test_hands_over_any_other_file_as_a_download(self):
        for name in ("cut.fcpxml", "master.mov", "stems.zip", "look.cube"):
            result = self.run_cli(self.file(name), "交付")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                self.uploaded(),
                [str(self.dir / name), "--artifact-type", "file", "--caption", "交付"],
            )

    def test_audio_and_documents_carry_a_content_type_the_pane_plays_or_reads(self):
        for name, content_type in (
            ("music.mp3", "audio/mpeg"),
            ("旁白.wav", "audio/wav"),
            ("mix.M4A", "audio/mp4"),
            ("brief.md", "text/markdown"),
            ("script.pdf", "application/pdf"),
        ):
            result = self.run_cli(self.file(name), "素材")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                self.uploaded(),
                [
                    str(self.dir / name),
                    "--artifact-type",
                    "file",
                    "--caption",
                    "素材",
                    "--content-type",
                    content_type,
                ],
            )

    def test_publishes_several_files_in_one_call_in_order(self):
        frames = [self.file(f"shot{n}.jpg") for n in (1, 2, 3)]
        music, cut = self.file("music.mp3"), self.file("v01.mp4")
        result = self.run_cli(
            frames[0],
            "分镜 1 · 开场",
            frames[1],
            "分镜 2",
            frames[2],
            "分镜 3",
            music,
            "配乐",
            "--file",
            self.file("master.mov"),
            "母版",
            cut,
            "成片 v1",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        # One line of JSON per pair, compact, so a grep for the ids counts every one.
        self.assertEqual(len(ARTIFACT_ID_GREP.findall(result.stdout)), 6)
        self.assertEqual(
            [r["artifactId"] for r in self.results(result)], ["a1", "a2", "a3", "a4", "a5", "a6"]
        )
        self.assertEqual(
            self.summary(result),
            "published 6/6: 分镜 1 · 开场, 分镜 2, 分镜 3, 配乐, 母版, 成片 v1",
        )
        uploads = self.uploads()
        self.assertEqual([u[0] for u in uploads][:3], [str(f) for f in frames])
        self.assertEqual(uploads[0][1:], ["--caption", "分镜 1 · 开场"])
        self.assertEqual(uploads[3][-2:], ["--content-type", "audio/mpeg"])
        self.assertEqual(uploads[4][1:3], ["--artifact-type", "file"])
        # The final cut is published last, as a video.
        self.assertEqual(uploads[-1][0], str(cut))
        self.assertIn("video", uploads[-1])

    def test_a_bad_pair_publishes_nothing(self):
        self.env["FAKE_PROBE"] = probe(codec="hevc")
        result = self.run_cli(self.file("a.png"), "A", self.file("cut.mp4"), "Cut")
        self.assertEqual(result.returncode, 1)
        self.assertIn("nothing was published", result.stderr)
        self.assertEqual(self.uploads(), [])

        result = self.run_cli(self.file("a.png"), "A", self.dir / "missing.png", "B")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.uploads(), [])

        self.assertEqual(self.run_cli(self.file("a.png"), "A", self.file("b.png")).returncode, 2)
        self.assertEqual(self.uploads(), [])

    def test_a_failed_upload_does_not_stop_the_rest(self):
        failing = self.file("a.png")
        self.env["FAIL_UPLOAD"] = str(failing)
        result = self.run_cli(failing, "A", self.file("b.png"), "B")
        self.assertEqual(result.returncode, 1)
        self.assertIn(f'not published: "A" ({failing})', result.stderr)
        self.assertEqual(len(self.uploads()), 2)
        self.assertEqual(self.summary(result), "published 1/2: B")

        # Publishing both again uploads only the one that failed.
        del self.env["FAIL_UPLOAD"]
        result = self.run_cli(failing, "A", self.dir / "b.png", "B")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            [u[0] for u in self.uploads()], [str(failing), str(self.dir / "b.png"), str(failing)]
        )
        self.assertTrue(self.summary(result).startswith("published 2/2: A, B"))

    def test_publishing_the_same_files_again_returns_what_they_already_became(self):
        frames = [self.file(f"shot{n}.jpg", f"frame {n}".encode()) for n in (1, 2)]
        cut = self.file("x.mp4", b"cut v1")
        pairs = [frames[0], "分镜 1", frames[1], "分镜 2", cut, "成片 v1"]
        first = self.run_cli(*pairs)
        self.assertEqual(first.returncode, 0, first.stderr)

        again = self.run_cli(*pairs)
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(len(self.uploads()), 3)
        results = self.results(again)
        self.assertEqual(
            [r["artifactId"] for r in results], [r["artifactId"] for r in self.results(first)]
        )
        self.assertTrue(all(r["alreadyPublished"] for r in results))
        self.assertEqual([r["title"] for r in results], ["分镜 1", "分镜 2", "成片 v1"])
        self.assertEqual(len(ARTIFACT_ID_GREP.findall(again.stdout)), 3)
        self.assertEqual(
            self.summary(again),
            "published 3/3: 分镜 1, 分镜 2, 成片 v1 "
            "(already published, not uploaded again: 分镜 1, 分镜 2, 成片 v1)",
        )

        # Twice in one call is once too.
        self.file("shot3.jpg", b"frame 3")
        result = self.run_cli(self.dir / "shot3.jpg", "分镜 3", self.dir / "shot3.jpg", "分镜 3")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.uploads()), 4)
        self.assertEqual(len({r["artifactId"] for r in self.results(result)}), 1)

    def test_a_new_version_is_still_published(self):
        cut = self.file("x.mp4", b"cut v1")
        self.assertEqual(self.run_cli(cut, "成片 v1").returncode, 0)
        # New content under the same name and title (a re-render), a new title, a new file name,
        # or the same file as a download: each is published.
        cut.write_bytes(b"cut v1, recut")
        self.assertEqual(self.run_cli(cut, "成片 v1").returncode, 0)
        self.assertEqual(self.run_cli(cut, "成片 v2 · 开场换成产品特写").returncode, 0)
        self.assertEqual(
            self.run_cli(self.file("y.mp4", b"cut v1, recut"), "成片 v1").returncode, 0
        )
        self.assertEqual(self.run_cli("--file", cut, "成片 v1").returncode, 0)
        self.assertEqual(len(self.uploads()), 5)
        self.assertNotIn("already", self.summary(self.run_cli("--file", cut, "母版")))
        self.assertEqual(len(self.uploads()), 6)

    def test_another_session_publishes_its_own(self):
        shot = self.file("shot1.jpg")
        self.assertEqual(self.run_cli(shot, "分镜 1").returncode, 0)
        self.env["SESSION_CONFIG"] = json.dumps({"sessionId": "s2"})
        result = self.run_cli(shot, "分镜 1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.uploads()), 2)
        self.assertNotIn("alreadyPublished", result.stdout)

    def test_publishes_when_the_ledger_cannot_be_kept(self):
        self.env["MEDIA_PREVIEW_LEDGER"] = str(self.dir / "missing" / "published.json")
        shot = self.file("shot1.jpg")
        for _ in range(2):
            result = self.run_cli(shot, "分镜 1")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.summary(result), "published 1/1: 分镜 1")
        self.assertEqual(len(self.uploads()), 2)

    def test_file_flag_hands_over_a_previewable_master(self):
        self.env["FAKE_PROBE"] = probe(codec="hevc")
        master = self.file("master.mp4")
        result = self.run_cli("--file", master, "母版")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            self.uploaded(), [str(master), "--artifact-type", "file", "--caption", "母版"]
        )

    def test_refuses_missing_titles(self):
        self.assertEqual(self.run_cli(self.file("a.png"), " ").returncode, 1)
        self.assertEqual(self.run_cli(self.file("a.png")).returncode, 2)
        self.assertFalse(self.args_file.exists())


if __name__ == "__main__":
    unittest.main()
