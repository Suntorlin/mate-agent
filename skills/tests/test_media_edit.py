"""Tests for the media-edit skill.

Unit tests cover the pure logic (spans, line breaking, karaoke timing, beat marks, crop path).
Integration tests run the real commands on small synthetic media; each skips when its tools are
missing (ffmpeg with libass, fontconfig, the Python libraries or the baked-in models), so the
whole file runs green on a laptop and fully inside the sandbox image:

    python3 -m unittest skills/tests/test_media_edit.py -v
"""

import importlib.util
import itertools
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[2] / "skills/builtin/media-edit/scripts"
MEDIA_EDIT = SCRIPTS / "media-edit"
sys.path.insert(0, str(SCRIPTS))

from mediaedit import (  # noqa: E402
    asr,
    beatcut,
    captions,
    fxcaptions,
    grade,
    jumpcut,
    loudness,
    reframe,
)
from mediaedit.captions import Word  # noqa: E402

MODELS = Path(os.environ.get("MEDIA_MODELS", "/opt/media/models"))


def has_module(name):
    return importlib.util.find_spec(name) is not None


def has_filter(name):
    if not shutil.which("ffmpeg"):
        return False
    out = subprocess.run(["ffmpeg", "-hide_banner", "-filters"], capture_output=True, text=True)
    return f" {name} " in out.stdout


def width_by_chars(text):
    """Stand-in font: CJK glyphs 70 px, everything else 38 px."""
    return sum(70 if captions.is_cjk(ch) else 38 for ch in text)


def run_media_edit(*args, cwd):
    result = subprocess.run(
        [sys.executable, str(MEDIA_EDIT), *map(str, args)], capture_output=True, text=True, cwd=cwd
    )
    if result.returncode:
        raise AssertionError(f"media-edit {args[0]} failed:\n{result.stderr[-2000:]}")
    return json.loads(result.stdout)


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *map(str, args)], check=True)


JUMP_WORDS = (
    {"word": " Hello", "start": 1.0, "end": 1.4},
    {"word": " um,", "start": 1.5, "end": 1.7},
    {"word": " world", "start": 1.8, "end": 2.2},
    {"word": " again", "start": 4.0, "end": 4.5},
)


class JumpcutLogicTest(unittest.TestCase):
    words = JUMP_WORDS

    def test_merges_short_gaps_and_drops_fillers_and_long_pauses(self):
        spans = jumpcut.keep_spans(self.words, duration=6, min_gap=0.35, pad=0.1)
        # The filler's 0.1 s gaps are under min_gap, yet it is cut out: no merge reaches across it.
        self.assertEqual(spans, [(0.9, 1.5), (1.7, 2.3), (3.9, 4.6)])

    def test_keeps_a_filler_when_asked(self):
        spans = jumpcut.keep_spans(self.words, duration=6, drop_fillers=False)
        self.assertEqual(spans, [(0.9, 2.3), (3.9, 4.6)])

    def test_drop_ranges_cut_a_retake_and_no_padding_reaches_into_them(self):
        words = [
            {"word": " take", "start": 1.0, "end": 1.4},
            {"word": " one,", "start": 1.5, "end": 1.9},
            {"word": " take", "start": 2.1, "end": 2.5},
            {"word": " two", "start": 2.6, "end": 3.0},
        ]
        spans = jumpcut.keep_spans(words, duration=5, drop=[(0.95, 2.0)])
        self.assertEqual(spans, [(2.0, 3.1)])

    def test_drop_range_parsing(self):
        self.assertEqual(jumpcut.parse_range("3.1-7.25"), (3.1, 7.25))
        for bad in ("7-3", "abc", "5"):
            with self.assertRaises(jumpcut.argparse.ArgumentTypeError):
                jumpcut.parse_range(bad)

    def test_a_chinese_filler_between_two_words_is_cut_out(self):
        # Per-character ASR timing around "第一个原因 嗯 是开头太慢".
        words = [
            {"word": "因", "start": 14.80, "end": 14.96},
            {"word": "嗯", "start": 15.08, "end": 15.30},
            {"word": "是", "start": 15.31, "end": 15.50},
        ]
        spans = jumpcut.keep_spans(words, duration=20, fps=25)
        self.assertEqual(len(spans), 2)
        self.assertLessEqual(spans[0][1], 15.08)
        self.assertGreaterEqual(spans[1][0], 15.30)

    def test_spans_snap_to_whole_frames(self):
        spans = jumpcut.keep_spans(self.words, duration=6, fps=25)
        for a, b in spans:
            self.assertAlmostEqual(a * 25, round(a * 25), places=3)
            self.assertAlmostEqual(b * 25, round(b * 25), places=3)

    def test_filter_uses_trim_concat_with_short_fades(self):
        script = jumpcut.filter_script([(0.9, 2.3), (3.9, 4.6)], video=True)
        self.assertIn("concat=n=2:v=1:a=1", script)
        self.assertIn("afade=t=in:d=0.01", script)
        self.assertNotIn("aselect", script)

    def test_remap_words_onto_cut_timeline(self):
        spans = [(0.9, 2.3), (3.9, 4.6)]
        remapped = jumpcut.remap_words(self.words, spans)
        self.assertEqual([w["start"] for w in remapped], [0.1, 0.6, 0.9, 1.5])


class CaptionLogicTest(unittest.TestCase):
    def zh_words(self):
        # Whisper-like per-character tokens, ASCII comma included.
        text = "我们今天去看视频,然后一起吃饭。"
        return [Word(ch, 0.2 * i, 0.2 * i + 0.18) for i, ch in enumerate(text)]

    @unittest.skipUnless(has_module("jieba"), "jieba not installed")
    def test_chinese_is_grouped_into_words_and_punctuation_made_fullwidth(self):
        grouped = captions.group_words(self.zh_words())
        texts = [w.text for w in grouped]
        self.assertIn("视频", texts)
        self.assertIn("，", "".join(texts))  # noqa: RUF001
        self.assertNotIn(",", "".join(texts))

    @unittest.skipUnless(has_module("jieba"), "jieba not installed")
    def test_lines_fit_never_split_words_never_start_with_punctuation(self):
        grouped = captions.group_words(self.zh_words())
        lines = captions.break_lines(grouped, width_by_chars, max_width=6 * 70)
        for line in lines:
            self.assertLessEqual(width_by_chars(captions.display_text(line)), 6 * 70)
            self.assertNotIn(line[0].text[:1], captions.NO_LINE_START)
        joined = [w.text for line in lines for w in line]
        self.assertEqual(joined, [w.text for w in grouped])  # words kept whole and in order

    def test_english_breaks_at_pauses_and_sentence_ends(self):
        words = [
            Word(" One", 0.0, 0.3),
            Word(" two.", 0.3, 0.6),
            Word(" Three", 0.7, 1.0),
            Word(" four", 2.0, 2.3),
        ]
        lines = captions.break_lines(words, width_by_chars, max_width=2000)
        self.assertEqual(
            [captions.display_text(line) for line in lines], ["One two.", "Three", "four"]
        )

    def test_karaoke_durations_follow_word_starts(self):
        line = [Word("a", 1.0, 1.2), Word("b", 1.5, 1.7), Word("c", 2.0, 2.4)]
        self.assertEqual(captions.karaoke_text(line), "{\\k50}a{\\k50}b{\\k40}c")

    def test_timestamps(self):
        self.assertEqual(captions.ts_srt(3725.042), "01:02:05,042")
        self.assertEqual(captions.ts_ass(3725.042), "1:02:05.04")


class FxCaptionLogicTest(unittest.TestCase):
    def test_chinese_numbers_become_douyin_numbers(self):
        self.assertEqual(fxcaptions.cn_number("三"), 3)
        self.assertEqual(fxcaptions.cn_number("十二"), 12)
        self.assertEqual(fxcaptions.cn_number("四十"), 40)
        self.assertIsNone(fxcaptions.cn_number("三四五"))
        self.assertEqual(fxcaptions.punchy("三倍", "播放量涨了"), "×3")  # noqa: RUF001
        self.assertEqual(fxcaptions.punchy("四成", "到店客人多了"), "+40%")
        self.assertEqual(fxcaptions.punchy("两成", "成本少了"), "−20%")  # noqa: RUF001
        self.assertEqual(fxcaptions.punchy("三年", "开咖啡店"), "3年")
        self.assertEqual(fxcaptions.punchy("先拍起来", ""), "先拍起来")

    def test_numerals_are_words_with_a_unit(self):
        for text in ("三倍", "四成", "40%", "3年", "×3", "10万"):  # noqa: RUF001
            self.assertTrue(fxcaptions.is_numeral(text), text)
        for text in ("一句话", "我们", "AI"):
            self.assertFalse(fxcaptions.is_numeral(text), text)

    def test_whisper_spaces_and_segments_become_punctuation(self):
        data = {
            "segments": [
                {"words": [
                    {"word": "大家好", "start": 0.0, "end": 0.4},
                    {"word": " 我是", "start": 0.4, "end": 0.8},
                    {"word": "小林", "start": 0.8, "end": 1.2},
                ]},
                {"words": [{"word": "先拍起来", "start": 1.5, "end": 2.0}]},
            ]
        }  # fmt: skip
        words = fxcaptions.punctuated_words(data)
        self.assertEqual([w.text for w in words], ["大家好，", "我是", "小林。", "先拍起来。"])  # noqa: RUF001

    def test_latin_words_keep_one_space_only_between_them(self):
        self.assertEqual(fxcaptions.joined(["用", "AI", "做"]), "用AI做")
        self.assertEqual(fxcaptions.joined(["Agent", "Engine", "好用"]), "Agent Engine好用")

    def test_heroes_never_overlap_and_last_at_least_a_beat(self):
        heroes = fxcaptions.space_heroes(
            [
                {"text": "b", "at": 3.0, "until": 3.2},
                {"text": "a", "at": 1.0, "until": 4.0},
                {"text": "c", "at": 3.3, "until": 5.0},
            ],
            duration=6.0,
        )
        self.assertEqual([h["text"] for h in heroes], ["a", "b"])
        for first, second in itertools.pairwise(heroes):
            self.assertGreaterEqual(second["at"] - first["until"], fxcaptions.HERO_GAP - 1e-6)
        self.assertGreaterEqual(heroes[0]["until"] - heroes[0]["at"], 1.2)
        self.assertGreaterEqual(heroes[1]["until"] - heroes[1]["at"], 0.8 - 1e-6)  # cut short by c

    @unittest.skipUnless(has_module("jieba"), "jieba not installed")
    def test_suggests_growth_numbers_and_the_closing_line_as_heroes(self):
        data = {
            "segments": [
                {"words": [{"word": w, "start": s, "end": s + 0.3} for w, s in (
                    ("播放量", 0.0), ("涨了", 0.3), ("三倍", 0.6),
                    (" 到店", 2.4), ("客人", 2.7), ("多了", 3.0), ("四成", 3.3),
                )]},
                {"words": [{"word": "先拍起来", "start": 6.0, "end": 6.6}]},
            ]
        }  # fmt: skip
        words = fxcaptions.punctuated_words(data)
        lines = [[w] for w in words]
        keywords, heroes = fxcaptions.suggest(lines, duration=12.0)
        self.assertIn("三倍", keywords)
        self.assertIn("四成", keywords)
        self.assertEqual([h["text"] for h in heroes], ["×3", "+40%", "先拍起来"])  # noqa: RUF001
        self.assertEqual(heroes[0]["label"], "播放量")

    @unittest.skipUnless(
        all(has_module(m) for m in ("numpy", "cv2", "PIL")) and shutil.which("fc-match"),
        "numpy/cv2/PIL or fontconfig missing",
    )
    def test_closing_hero_stays_up_through_the_last_frame(self):
        import numpy as np

        plan = {
            "video": {"width": 180, "height": 320, "fps": 25, "duration": 4.0},
            "lines": [],
            "heroes": [
                {"text": "×3", "at": 0.2, "until": 1.4},  # noqa: RUF001
                {"text": "先拍起来", "at": 2.0, "until": 3.98},  # within a frame of the end
            ],
        }
        renderer = fxcaptions.Renderer(plan, fxcaptions.Sprites())
        grey = np.full((320, 180, 3), 90, np.uint8)
        peak = renderer.frame(grey, 3.0, None)  # settled: no shake, no speed lines
        self.assertFalse(np.array_equal(peak, grey))
        for t in (3.96, 3.99, 4.04):  # the last frames, which --hold repeats
            np.testing.assert_array_equal(renderer.frame(grey, t, None), peak, err_msg=f"t={t}")
        # A hero that ends mid-clip still fades out.
        self.assertFalse(
            np.array_equal(renderer.frame(grey, 1.38, None), renderer.frame(grey, 0.8, None))
        )
        self.assertTrue(fxcaptions.needs_matte(plan, 4.04))
        self.assertFalse(fxcaptions.needs_matte(plan, 1.6))

    @unittest.skipUnless(
        all(has_module(m) for m in ("numpy", "cv2", "PIL")) and shutil.which("fc-match"),
        "numpy/cv2/PIL or fontconfig missing",
    )
    def test_heroes_tuck_only_their_lower_edge_behind_the_head(self):
        import numpy as np

        width, height = 540, 960
        yy, xx = np.mgrid[0:height, 0:width]
        head = ((xx - width / 2) / (width * 0.2)) ** 2 + (
            (yy - height * 0.3) / (height * 0.16)
        ) ** 2
        alpha = ((head <= 1) | (yy > height * 0.42)).astype(np.float32)  # head over shoulders
        plan = {
            "video": {"width": width, "height": height, "fps": 25, "duration": 6.0},
            "lines": [],
            "heroes": [
                {"text": text, "at": at, "until": at + 1.2}
                for text, at in (("×3", 0.2), ("+40%", 2.0), ("先拍起来", 4.0))  # noqa: RUF001
            ],
        }
        renderer = fxcaptions.Renderer(plan, fxcaptions.Sprites(), dict.fromkeys(range(3), alpha))
        for hero in renderer.heroes:
            check = fxcaptions.hero_check(renderer, hero, hero["at"], alpha, None)
            self.assertEqual(check["note"], "ok", check)
            self.assertGreaterEqual(check["covered"], fxcaptions.COVER_MIN - 0.05, check)
            self.assertLessEqual(check["covered"], fxcaptions.COVER_MAX + 0.05, check)
            self.assertLessEqual(check["worst_char"], fxcaptions.CHAR_MAX + 0.05, check)


class BeatLogicTest(unittest.TestCase):
    def test_marks_every_n_beats_and_extrapolate(self):
        beats = [0.5, 1.0, 1.5, 2.0, 2.5]
        self.assertEqual(beatcut.cut_marks(beats, shots=3, every=2), [0.5, 1.5, 2.5, 3.5])

    def test_frame_counts_do_not_drift(self):
        marks = [0.0, 0.55, 1.1, 1.65, 2.2]
        frames = beatcut.shot_frames(marks, 30)
        self.assertEqual(sum(frames), 66)
        for i in range(1, len(marks)):
            self.assertLessEqual(abs(sum(frames[:i]) / 30 - marks[i]), 1 / 60 + 1e-9)


@unittest.skipUnless(has_module("scipy") and has_module("numpy"), "numpy/scipy not installed")
class ReframeLogicTest(unittest.TestCase):
    def test_hold_then_fallback_to_center(self):
        centers = [500.0] + [None] * 10
        targets = reframe.fill_targets(centers, [None] * 11, 1920, "center")
        self.assertEqual(targets[:6], [500.0] * 6)  # held for HOLD_SECONDS (5 samples)
        self.assertEqual(targets[-1], 960.0)

    def test_smoothing_cuts_on_jumps_instead_of_panning(self):
        path = reframe.smooth_path([300.0] * 20 + [1500.0] * 20, 1920)
        self.assertAlmostEqual(path[19], 300.0, places=3)
        self.assertAlmostEqual(path[20], 1500.0, places=3)

    def test_face_in_frame_counts_visible_part(self):
        boxes = [(-50.0, 0.0, 300.0, 300.0), (1000.0, 0.0, 300.0, 300.0)]
        lefts = [0] * 10
        share = reframe.face_in_frame(boxes, [0, 5], lefts, 606, 1920)
        self.assertEqual(share, 0.5)


class LoudnessLogicTest(unittest.TestCase):
    def test_linear_filter_raises_lra_to_cover_source(self):
        measured = {
            "input_i": "-23.0",
            "input_tp": "-6.0",
            "input_lra": "14.2",
            "input_thresh": "-33.5",
            "target_offset": "0.3",
        }
        text = loudness.apply_filter(measured, -14, -1.5)
        self.assertIn("LRA=16", text)
        self.assertIn("linear=true", text)
        self.assertIn("TP=-1.5", text)

    def test_retries_lower_until_encoded_peak_passes(self):
        peaks = iter([-0.4, -0.9, -1.3])
        calls = []
        args = SimpleNamespace(input="in.wav", output=None, target=-14.0, tp=-1.5, ceiling=-1.0)
        measured = {"input_i": "-20", "input_tp": "-9", "input_lra": "5", "input_thresh": "-30",
                    "target_offset": "0"}  # fmt: skip
        with (
            mock.patch.object(loudness, "probe", return_value=SimpleNamespace(has_audio=True, has_video=False)),
            mock.patch.object(loudness, "loudnorm_measure", return_value=measured),
            mock.patch.object(loudness, "ffmpeg", side_effect=lambda *a: calls.append(a) or ""),
            mock.patch.object(loudness, "measure_output", side_effect=lambda _: (-14.1, next(peaks))),
            mock.patch.object(loudness, "emit") as emit,
        ):  # fmt: skip
            loudness.main(args)
        attempts = emit.call_args.args[0]["attempts"]
        self.assertEqual([a["tp_target"] for a in attempts], [-1.5, -2.0, -2.5])
        self.assertTrue(emit.call_args.args[0]["pass"])
        self.assertFalse(emit.call_args.args[0]["limited"])
        self.assertEqual(len(calls), 3)

    def test_a_source_without_headroom_goes_through_the_limiter(self):
        quiet_hot = {"input_i": "-21.5", "input_tp": "0.2"}
        roomy = {"input_i": "-20", "input_tp": "-9"}
        self.assertTrue(loudness.needs_limiter(quiet_hot, -14, -1.5))
        self.assertFalse(loudness.needs_limiter(roomy, -14, -1.5))
        text = loudness.limiter_filter(7.5, -2.5)
        self.assertIn("volume=7.50dB", text)
        self.assertIn("aresample=192000,alimiter=limit=0.7499", text)

    def test_limited_path_adds_back_lost_loudness_and_lowers_the_limit(self):
        # First render: peaks fine but 1.1 dB short; second: loud enough but peaks over; third: ok.
        results = iter([(-15.1, -1.4), (-14.2, -0.7), (-14.3, -1.2)])
        filters = []
        args = SimpleNamespace(input="in.wav", output=None, target=-14.0, tp=-1.5, ceiling=-1.0)
        measured = {"input_i": "-21.5", "input_tp": "0.2", "input_lra": "5", "input_thresh": "-32",
                    "target_offset": "0"}  # fmt: skip
        with (
            mock.patch.object(loudness, "probe", return_value=SimpleNamespace(has_audio=True, has_video=False)),
            mock.patch.object(loudness, "loudnorm_measure", return_value=measured),
            mock.patch.object(loudness, "ffmpeg", side_effect=lambda *a: filters.append(a[a.index("-af") + 1]) or ""),
            mock.patch.object(loudness, "measure_output", side_effect=lambda _: next(results)),
            mock.patch.object(loudness, "emit") as emit,
        ):  # fmt: skip
            loudness.main(args)
        report = emit.call_args.args[0]
        self.assertTrue(report["limited"])
        self.assertTrue(report["pass"])
        self.assertEqual([a["tp_target"] for a in report["attempts"]], [-2.5, -2.5, -3.0])
        self.assertIn("volume=7.50dB", filters[0])
        self.assertIn("volume=8.60dB", filters[1])  # +1.1 dB back


@unittest.skipUnless(has_module("numpy"), "numpy not installed")
class GradeLogicTest(unittest.TestCase):
    def test_a_blue_cast_gets_less_blue_and_more_red_at_reduced_strength(self):
        import numpy as np

        frame = np.full((40, 40, 3), (0.40, 0.45, 0.55), np.float32)
        c = grade.measure_correction([frame])
        self.assertGreater(c["red_gain"], 1.0)
        self.assertLess(c["blue_gain"], 1.0)
        # 60% of the full gray-world gain (0.45 / 0.55 = 0.818, clamped to 0.85).
        self.assertAlmostEqual(c["blue_gain"], 1 + 0.6 * (0.85 - 1), places=3)

    def test_levels_never_stretch_more_than_the_limit(self):
        import numpy as np

        frame = np.linspace(0.3, 0.6, 1600, dtype=np.float32).reshape(40, 40, 1).repeat(3, axis=2)
        c = grade.measure_correction([frame])
        self.assertEqual((c["black"], c["white"]), (0.08, 0.92))

    def test_looks_share_the_correction_and_original_is_untouched(self):
        c = {"red_gain": 0.9, "blue_gain": 1.05, "black": 0.02, "white": 0.98}
        self.assertIsNone(grade.look_filter("original", c))
        self.assertEqual(grade.look_filter("base", c), grade.base_filter(c))
        self.assertTrue(grade.look_filter("vivid", c).startswith(grade.base_filter(c) + ","))
        with self.assertRaises(SystemExit):
            grade.look_filter("teal-orange", c)

    def test_skin_warning_bounds(self):
        self.assertIsNone(grade.skin_warning({"hue": 18, "saturation": 0.4}))
        self.assertEqual(grade.skin_warning({"hue": 2, "saturation": 0.4}), "skin reads red")
        self.assertEqual(grade.skin_warning({"hue": 40, "saturation": 0.4}), "skin reads yellow")
        self.assertEqual(grade.skin_warning({"hue": 20, "saturation": 0.7}), "skin reads orange")
        self.assertIsNone(grade.skin_warning(None))


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
class IntegrationTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def tone_video(self, name="talk.mp4", seconds=6):
        """Beeps (speech stand-in) with silences, on a moving test pattern."""
        path = self.dir / name
        beeps = "sin(2*PI*440*t)*0.5*between(mod(t\\,2)\\,0\\,1.2)"
        ffmpeg(
            "-f", "lavfi", "-i", f"testsrc2=s=640x360:r=25:d={seconds}",
            "-f", "lavfi", "-i", f"aevalsrc={beeps}:s=48000:d={seconds}",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path,
        )  # fmt: skip
        return path

    @unittest.skipUnless(
        has_module("numpy") and has_module("PIL") and shutil.which("fc-match"),
        "numpy, Pillow or fontconfig missing",
    )
    def test_grade_previews_every_look_then_applies_one(self):
        source = self.tone_video()
        result = run_media_edit("grade", source, "-o", self.dir / "looks.jpg", cwd=self.dir)
        self.assertEqual(set(result["looks"]), set(grade.LOOKS))
        self.assertTrue((self.dir / "looks.jpg").exists())
        graded = run_media_edit(
            "grade", source, "--look", "natural", "-o", self.dir / "g.mp4", cwd=self.dir
        )
        self.assertEqual(graded["look"], "natural")
        self.assertTrue((self.dir / "g.mp4").exists())

    def test_loudness_reaches_target_on_a_quiet_source_with_hot_peaks(self):
        # A quiet tone with a full-scale click every second: linear gain alone cannot reach -14.
        path = self.dir / "hot.wav"
        expr = "0.05*sin(2*PI*220*t)+0.95*lt(mod(t\\,1)\\,0.002)"
        ffmpeg("-f", "lavfi", "-i", f"aevalsrc={expr}:s=48000:d=8", path)
        result = run_media_edit("loudness", path, "-o", self.dir / "hot.m4a", cwd=self.dir)
        self.assertTrue(result["limited"])
        self.assertTrue(result["pass"])
        self.assertLessEqual(result["true_peak"], -1.0)
        self.assertAlmostEqual(result["lufs"], -14.0, delta=1.0)

    def test_loudness_hits_target_after_encode(self):
        source = self.tone_video()
        result = run_media_edit("loudness", source, "-o", self.dir / "out.mp4", cwd=self.dir)
        self.assertTrue(result["pass"])
        self.assertLessEqual(result["true_peak"], -1.0)
        self.assertAlmostEqual(result["lufs"], -14.0, delta=1.0)

    def test_jumpcut_removes_silences_and_keeps_sync(self):
        source = self.tone_video()
        words = {
            "language": "en",
            "duration": 6,
            "segments": [
                {
                    "start": 0,
                    "end": 6,
                    "text": "",
                    "words": [
                        {"word": f" w{i}", "start": 2 * i + 0.1, "end": 2 * i + 1.1}
                        for i in range(3)
                    ],
                }
            ],
        }
        (self.dir / "words.json").write_text(json.dumps(words))
        out = self.dir / "cut.mp4"
        result = run_media_edit(
            "jumpcut", source, "--words", self.dir / "words.json", "-o", out, cwd=self.dir
        )
        self.assertEqual(result["segments_kept"], 3)
        self.assertAlmostEqual(result["kept_s"], 3.6, delta=0.1)
        streams = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "stream=duration", "-of", "csv=p=0", out],
            capture_output=True,
            text=True,
        ).stdout.split()
        video, audio = (float(s) for s in streams[:2])
        self.assertLess(abs(video - audio), 0.05)

    @unittest.skipUnless(has_module("scenedetect") and has_module("cv2"), "scenedetect missing")
    def test_scenes_and_contact_sheet(self):
        parts = []
        for i, source in enumerate(("testsrc2", "smptehdbars", "rgbtestsrc")):
            part = self.dir / f"p{i}.mp4"
            ffmpeg("-f", "lavfi", "-i", f"{source}=s=640x360:r=25:d=2", "-pix_fmt", "yuv420p", part)
            parts.append(f"file '{part}'")
        (self.dir / "list.txt").write_text("\n".join(parts))
        video = self.dir / "shots.mp4"
        ffmpeg("-f", "concat", "-safe", "0", "-i", self.dir / "list.txt", "-c", "copy", video)
        result = run_media_edit("scenes", video, "-o", self.dir / "s.json", cwd=self.dir)
        self.assertEqual(result["shots"], 3)
        for got, want in zip(result["cuts_s"], (2.0, 4.0), strict=True):
            self.assertAlmostEqual(got, want, delta=0.1)
        if shutil.which("fc-match") and has_module("PIL"):
            sheet = run_media_edit("contact", video, "--scenes", self.dir / "s.json", cwd=self.dir)
            self.assertEqual(sheet["frames"], 3)
            self.assertTrue(Path(sheet["output"]).exists())

    @unittest.skipUnless(has_module("librosa"), "librosa missing")
    def test_beatcut_cuts_on_beats(self):
        music = self.dir / "clicks.wav"
        # 120 BPM click track: one beat every 0.5 s.
        ffmpeg(
            "-f", "lavfi", "-i",
            "aevalsrc=sin(2*PI*1000*t)*exp(-60*mod(t\\,0.5)):s=22050:d=12", music,
        )  # fmt: skip
        clip = self.tone_video("clip.mp4", 4)
        out = self.dir / "beat.mp4"
        result = run_media_edit(
            "beatcut", music, clip, clip, clip, "--size", "360x640", "-o", out, cwd=self.dir
        )
        self.assertAlmostEqual(result["tempo_bpm"], 120, delta=3)
        for cut in result["cuts_s"]:
            self.assertAlmostEqual(
                cut % 0.5 if cut % 0.5 < 0.25 else cut % 0.5 - 0.5, 0, delta=0.05
            )

    @unittest.skipUnless(
        has_filter("arnndn") and (MODELS / "rnnoise-sh.rnnn").exists() and has_module("scipy"),
        "arnndn or rnnoise model missing",
    )
    def test_voice_compensates_delay(self):
        source = self.tone_video()
        out = self.dir / "voice.wav"
        result = run_media_edit("voice", source, "-o", out, cwd=self.dir)
        self.assertGreater(result["delay_compensated_ms"], 0)
        self.assertTrue(out.exists())

    @unittest.skipUnless(
        has_filter("ass") and shutil.which("fc-match") and has_module("PIL"), "libass/fonts missing"
    )
    def test_captions_burn_from_words(self):
        source = self.tone_video()
        words = {
            "language": "en",
            "duration": 6,
            "segments": [
                {
                    "start": 0,
                    "end": 6,
                    "text": "",
                    "words": [
                        {"word": " Hello", "start": 0.2, "end": 0.6},
                        {"word": " there.", "start": 0.6, "end": 1.0},
                        {"word": " Again", "start": 2.1, "end": 2.6},
                    ],
                }
            ],
        }
        (self.dir / "w.json").write_text(json.dumps(words))
        result = run_media_edit(
            "captions", source, "--words", self.dir / "w.json", "--burn", "-o", self.dir / "c",
            cwd=self.dir,
        )  # fmt: skip
        self.assertEqual(result["lines"], 2)
        self.assertLessEqual(result["max_line_px"], result["limit_px"])
        self.assertIn("{\\k", (self.dir / "c.ass").read_text())
        self.assertTrue((self.dir / "c.mp4").exists())
        remotion = json.loads((self.dir / "c.remotion.json").read_text())
        self.assertEqual(remotion[0]["words"][0], {"text": "Hello", "start": 0.2, "end": 0.6})

    @unittest.skipUnless(
        all(has_module(m) for m in ("onnxruntime", "cv2", "jieba", "PIL"))
        and (MODELS / "modnet.onnx").exists()
        and (MODELS / "yunet.onnx").exists()
        and shutil.which("fc-match"),
        "fxcaptions models or libraries missing",
    )
    def test_fxcaptions_renders_rail_and_heroes_with_a_check_sheet(self):
        source = self.dir / "talk.mp4"
        ffmpeg(
            "-f", "lavfi", "-i", "testsrc2=s=360x640:r=25:d=4",
            "-f", "lavfi", "-i", "sine=f=220:d=4",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source,
        )  # fmt: skip
        words = {
            "language": "zh",
            "duration": 4,
            "segments": [
                {"words": [
                    {"word": "播放量", "start": 0.2, "end": 0.6},
                    {"word": "涨了", "start": 0.6, "end": 0.9},
                    {"word": "三倍", "start": 0.9, "end": 1.3},
                ]},
                {"words": [{"word": "先拍起来", "start": 2.4, "end": 3.0}]},
            ],
        }  # fmt: skip
        (self.dir / "w.json").write_text(json.dumps(words, ensure_ascii=False))
        result = run_media_edit(
            "fxcaptions", source, "--words", self.dir / "w.json", "--hold", "0.5",
            "-o", self.dir / "fx", cwd=self.dir,
        )  # fmt: skip
        self.assertEqual(result["size"], "1080x1920")
        # About one hero per 4 s, so a 4 s clip gets only the growth number.
        self.assertEqual([h["text"] for h in result["heroes"]], ["×3"])  # noqa: RUF001
        self.assertGreater(result["matted_frames"], 0)
        self.assertLess(result["matted_frames"], result["frames"])
        self.assertTrue((self.dir / "fx.check.jpg").exists())
        plan = json.loads((self.dir / "fx.fx.json").read_text())
        self.assertEqual([line["text"] for line in plan["lines"]], ["播放量涨了三倍", "先拍起来"])
        duration = float(
            subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                 self.dir / "fx.mp4"],
                capture_output=True, text=True,
            ).stdout
        )  # fmt: skip
        self.assertAlmostEqual(duration, 4.5, delta=0.15)

        # The closing line, run to the end, is still on screen through the held frames.
        import numpy as np

        plan["heroes"] = [{"text": "先拍起来", "label": "", "at": 2.4, "until": 4.0}]
        (self.dir / "end.fx.json").write_text(json.dumps(plan, ensure_ascii=False))
        run_media_edit(
            "fxcaptions", source, "--plan", self.dir / "end.fx.json", "--hold", "0.5",
            "-o", self.dir / "end", cwd=self.dir,
        )  # fmt: skip
        accent = np.array(fxcaptions.hex_rgb(fxcaptions.ACCENT), np.float32)

        def accent_pixels(t):
            ((_, rgb),) = fxcaptions.frames(self.dir / "end.mp4", 1080, 1920, [t])
            top = rgb[: 1920 // 2].astype(np.float32)
            return int((np.linalg.norm(top - accent, axis=2) < 40).sum())

        before, peak, held = accent_pixels(2.2), accent_pixels(3.0), accent_pixels(4.3)
        self.assertGreater(peak, 20 * max(1, before))
        self.assertGreater(held, peak * 0.8)


if __name__ == "__main__":
    unittest.main()
