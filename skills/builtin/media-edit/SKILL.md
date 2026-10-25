---
name: media-edit
description:
  Built-in editing commands for the user's own footage and for finished renders, each one command
  with sane defaults - captions (word-timed ASR captions, karaoke/bilingual, burn-in), fxcaptions
  (Douyin-style effect captions on a talking head - keywords pop, big words slam in behind the
  speaker; for "特效字幕", "炸裂字幕", "字幕藏在人后面"), jumpcut (remove silences and filler words;
  with --drop, retakes and false starts too), reframe (16:9 to 9:16 following the face), beatcut
  (cut clips to the music's beat), voice (clean up speech), grade (color correction and looks
  compared side by side, skin checked), loudness (-14 LUFS, true peak checked after encoding),
  scenes (cut detection) and contact (timecoded contact sheet). Also the rules for the other
  preinstalled media tools (Python libraries, ImageMagick, ffmpeg filters, Remotion 3D).
---

# media-edit

`media-edit <command> --help` documents every option. Each command prints a JSON summary on stdout
(output paths, measurements, `seconds`) and progress on stderr; read the JSON, then look at the
result (a frame, `media-edit contact`) before telling the user it is done. Everything runs offline
on the sandbox CPU (8 cores); times below are for that machine.

| command      | use it when                                                  | typical time                                       |
| ------------ | ------------------------------------------------------------ | -------------------------------------------------- |
| `transcribe` | you need the words and their timing (feeds captions/jumpcut) | 3 min English 53 s (small 33 s), 36 s Chinese 19 s |
| `captions`   | the video needs subtitles or word-by-word captions           | burn-in of 3 min 33 s (+ ASR)                      |
| `fxcaptions` | a talking head wants Douyin effect captions (特效/炸裂字幕)  | 12 s clip about 1 min (+ ASR)                      |
| `jumpcut`    | a talking clip has pauses, "um"s, dead air                   | 3 min 22 s (+ ASR)                                 |
| `reframe`    | a landscape clip must become 9:16 (or 4:5, 1:1)              | 3 min 1080p 47 s                                   |
| `beatcut`    | several clips should be cut to a music track's beat          | 8 shots 9 s                                        |
| `voice`      | speech is noisy, boomy or uneven                             | 3 min 14 s                                         |
| `grade`      | the user's footage looks flat, dark or off-color             | preview 2 s; 12 s clip 2.5 s                       |
| `loudness`   | before publishing anything with sound (always)               | 3 min 22 s                                         |
| `scenes`     | you need the shot list of a video                            | 3 min 14 s                                         |
| `contact`    | you want to see a whole video at a glance                    | 4 s                                                |

Order for the user's raw talking footage: `jumpcut` → `grade` → `reframe` → `voice` →
`captions --burn` → `loudness`. Re-encode as few times as possible; every command keeps the frame
rate and copies what it does not change.

Show the work (preview skill, "Show the process"): for an edit with several steps, a few frames of
the first cut (one per scene, titled by what they show) and any music you made go on the canvas in
one `media-preview` call; the finished `.final.mp4` is the last video you publish, and a revision is
the same title with the next number ("成片 v2"), what changed said in your reply.

## transcribe

faster-whisper with `large-v3-turbo` (default; needed for Chinese) or `small` (`--model small`,
about 2.5x faster, fine for an English rough cut). Language is detected; Chinese automatically gets
the simplified-Chinese prompt (without it Whisper drifts into traditional characters and drops
clauses). Check names, brands and numbers in the text (it heard "LUFS" as "了").

```bash
media-edit transcribe input.mp4 -o input.words.json
```

**Raw takes.** Whisper writes what was _meant_: it drops "呃，不对，重来", "这句再来一遍", stutters
and most fillers, and can join a broken-off first try to the end of its retake, so a cut planned
from its words can keep half of a sentence that was thrown away. When takes must be chosen, check
every planned cut by looking and listening (`media-edit contact` around it, a short clip of the
join), not by the words alone.

## captions

ASR word timing → lines broken by the real rendered width of the font (Noto Sans CJK Bold, 84% of a
9:16 frame), never inside a word (Chinese is segmented with jieba), never with punctuation at a line
start, at pauses and sentence ends, at most 3.5 s per line. Styles: `karaoke` (default; bold, each
word lights up yellow as it is spoken), `clean` (white, light outline), `bilingual` (spoken line
plus a smaller translation under it). Writes `<prefix>.srt`, `<prefix>.ass`, `<prefix>.lines.json`,
`<prefix>.remotion.json` (paste into a timeline's `captions`) and, with `--burn`, `<prefix>.mp4`.

```bash
media-edit captions clip.9x16.mp4 --burn -o captions/clip            # karaoke, burned in
media-edit captions clip.mp4 --words clip.words.json --style clean   # reuse an earlier ASR
```

Bilingual: run once, translate each entry of `<prefix>.lines.json` yourself, write a JSON list of
strings (same order and count), then
`media-edit captions clip.mp4 --words <prefix>.words.json --style bilingual --translations tr.json --burn`.
For a voiceover placed later on a timeline use `--offset <start seconds>` on the VO file. Fix
misheard words by editing the words JSON and rerunning with `--words`.

## fxcaptions

Douyin-style effect captions for **one person talking to camera in one shot** (split a multi-shot
edit with `scenes` first; two people on screen is not supported). The footage stays untouched; two
layers go on top:

- **rail**: the spoken line, word by word, in front of the speaker, centred below the chin (white,
  heavy outline; keywords bigger and in the accent colour, popping as they are spoken);
- **heroes**: a few big words (`×3`, `+40%`, `先拍起来`) slammed in **behind** the speaker - MODNet
  cuts her out, so her head covers the bottom of the lettering - with speed lines, a white flash and
  a short shake.

```bash
media-edit fxcaptions talk.mp4 --plan-only -o fx/talk          # transcribe, look at the face, suggest
# read and edit fx/talk.fx.json (keywords, heroes: text/label/at/until), then:
media-edit fxcaptions talk.mp4 --plan fx/talk.fx.json --hold 0.8 -o fx/talk
```

Without `--plan`/`--plan-only` it renders its own suggestion in one go. Output: `<prefix>.mp4`
(scaled to 1080 wide when a 9:16 source is smaller), `<prefix>.fx.json`, `<prefix>.words.json`, and
`<prefix>.check.jpg` (every hero at its peak plus three rail moments) - **read the check sheet**.

Rules for Chinese vertical video (the suggestion follows them; keep them when you edit the plan):

- Heroes are scarce: at most one per phrase, about one per 4 s, never two at once, 0.6 s apart.
  Growth numbers and the closing line first; a plain sentence stays on the rail.
- Numbers as Douyin writes them: 三倍 → `×3`, 四成 → `+40%` (`−` after 少/降/减), 三年 → `3年`. A
  hero's `label` (the small white line on its corner) names what the number is (`播放量`).
- Hero text 1-6 characters. Each hero is placed from the matte at its peak: the largest size and the
  most central, highest spot where the speaker covers 10-35% of it and no character more than 35%
  (only the lower edge tucked behind the head; it shrinks rather than lose a digit). The JSON
  reports `covered` and `worst_char` per hero with a `note`; to force a spot, give the hero
  `"bottom"` (fraction of the height where its lettering ends) and `"x"` (fraction of the width);
  `"scale"` (0.3-1) makes one hero smaller and still lets it find its own spot. Change the plan,
  never the tool's code.
- A hero whose `until` is the clip's end (the suggested closing line) never fades out: it stays up
  through the last frame and the whole `--hold`, so "end on the big words for 1.5 s" is just
  `--hold 1.5`.
- Everything stays out of Douyin's own UI: bottom 22% and the right-hand button column; the rail
  sits at `rail_y` (fraction of the height, default chin + 12%).
- Keywords are what the viewer should remember (numbers, names, the product); 1-2 per line at most.
- Fix misheard words in `<prefix>.words.json` and rerun with `--words` (a fresh plan) or edit the
  `lines` in the plan.

Measured on a 12.5 s AI-generated talking head (704x1280 → 1080x1964): only the 100 frames under a
hero are matted; plan 9 s, render 27 s on 8 cores, after an 18 s transcription.

## jumpcut

Keeps every word (plus 0.1 s of breath) and removes silences ≥ 0.35 s and filler words
(um/uh/嗯/呃); a filler is cut out even between two words with no pause around it. Each kept span is
cut from video and audio together on whole frames and joined with 10 ms audio fades (never ffmpeg
`aselect`: it desyncs audio). Also writes `<out>.words.json` with the word times on the new
timeline, so captions need no second ASR.

```bash
media-edit jumpcut talk.mp4 -o talk.cut.mp4            # --gap 0.6 for a calmer pace
media-edit captions talk.cut.mp4 --words talk.cut.words.json --burn
```

**Retakes.** jumpcut removes pauses and fillers, never a whole take; choosing takes is yours.
Transcribe, read the segments (each is one stretch of speech between pauses, with its times), and
for every sentence keep the last complete, fluent take: a take that breaks off
("……问，呃，不对，重来"), a stutter ("突然，突然"), a note to the crew ("这句再来一遍",
"等一下我喝口水") and talk before the first real line all go. Pass each range to cut as `--drop`, in
source seconds; the words inside it are removed and no breath padding reaches into it:

```bash
media-edit jumpcut raw.mp4 --words raw.words.json --drop 0-2.5 --drop 3.0-7.6 --drop 22.0-30.5 -o raw.cut.mp4
```

Then transcribe the cut again and read it start to end: every sentence once, none cut short. On the
49 s test (three retakes, two fillers, crew talk) this gave 20.9 s with nothing left over.

Measured: 3:14 talk → 2:43 (16% removed, 18 segments), re-transcription matched 98–99% of the words,
word timing within 26 ms (median) of the plan, audio and video lengths equal.

## reframe

YuNet face detection 5×/s; the crop follows the largest face, holds 1 s when it is lost, then falls
back to the center (`--fallback subject` follows motion instead, e.g. a product demo). The path is
smoothed without lag and cuts instead of panning when the subject jumps (a shot change). Reports
`face_seen_pct` and `face_in_frame_pct` (faces kept inside the crop).

```bash
media-edit reframe interview.mp4 -o interview.9x16.mp4              # --aspect 4:5 gives 1080x1350
```

Measured on a clip whose face sweeps across the frame: 100% of faces in frame vs 11% for a center
crop. Two people talking in turn: the crop sticks to the larger face; for a two-shot, use `render`
(the Remotion starter) with two crops instead.

## beatcut

librosa beat tracking; every shot lasts `--every` beats (2), counted in whole frames so cuts never
drift; videos are scaled to fill `--size` (1080x1920) and center-cropped; images work too. Music
starts on the first beat and fades out over the last 0.5 s. Writes `<out>.beats.json` (tempo, beats,
cut times).

```bash
media-edit beatcut assets/music.mp3 a.mp4 b.mp4 c.jpg d.mp4 --clip-start 1.5 -o renders/beat.mp4
```

Measured: cuts detected in the output landed exactly on the planned beat frames (107.7 BPM).

## voice

`highpass 80 Hz → arnndn (rnnoise) → EQ (-2 dB at 250 Hz, +2.5 dB at 3.5 kHz) → de-esser → compressor → limiter`,
then the chain's delay (≈15 ms) is measured by cross-correlation and removed, so lips stay in sync.
Video is copied. `--no-denoise` for already clean studio audio.

```bash
media-edit voice talk.mp4 -o talk.voice.mp4      # then loudness
```

Measured: speech-to-noise in pauses 7 dB → 34 dB on speech with pink noise and mains hum (ffmpeg's
`afftdn` alone: no improvement).

## loudness

Two-pass loudnorm to -14 LUFS with a -1.5 dBTP target, encodes (AAC 192k, video copied), measures
the encoded file and retries 0.5 dB lower while its true peak is above -1.0 dBTP (AAC raises peaks:
a -1.0 target measured -0.4 after encoding). A quiet recording with high peaks has no room for a
linear gain (an interview at -21.5 LUFS peaking at +0.2 stopped at -15.4); `limited: true` in the
JSON means it was raised by the gain with a true-peak limiter instead, which speech does not let you
hear. Exits 1 if it cannot pass.

```bash
media-edit loudness renders/v03.mp4 -o renders/v03.final.mp4    # publish the .final file
```

## grade

First the preview: three moments of the video (rows) under every look (columns), each frame made by
the same filter the final grade uses, so what you see is what you get. Every look starts from one
correction measured on the footage (white balance at 60% of gray-world, so a red wall stays a little
red; black and white points). For each look the JSON gives the skin's mean hue and saturation and a
`warning` when faces read red, yellow or orange; the sheet marks those looks.

```bash
media-edit grade talk.mp4 -o work/looks.jpg        # look at the sheet and the warnings, pick one
media-edit grade talk.mp4 --look natural -o talk.graded.mp4
```

Looks: `base` (correction only), `natural` (a little contrast and color; the safe default), `warm`,
`cool`, `film` (lifted blacks, softer, cool shadows and warm highlights), `vivid` (only for products
and food: it pushes skin). Choose by the people in the frame first, then the mood the creator asked
for; when you chose for them, show the sheet and say which look and why.

## Check before you show it

These are what reviewers of cut and dressed-up talking footage most often caught:

- **Every cut point.** After a cut, `media-edit contact --every 1` around each join (or transcribe
  the result) and read it start to end: every sentence once, none cut short, no doubled word at a
  join, no click. For retakes, compare against the plan you made from the words.
- **Faces stay clear.** Before rendering cards, lower thirds or motion over a person, check one
  frame per second across each overlay's whole time on screen, not just its first frame: heads move.
  Move the overlay, make it smaller, or drop it.
- **Motion where the words are.** A small animated mark timed to the word it illustrates (a drop
  when they say "water", a line drawn as two names are linked) reads as edited; the same mark at a
  random moment reads as decoration. Time overlays from the words.json, not by eye.
- **Numbers, not impressions.** Report the measured loudness and true peak, the duration against the
  plan, and the look and its skin numbers.

## scenes and contact

```bash
media-edit scenes reference/source.mp4 -o reference/scenes.json     # --detector adaptive for shaky footage
media-edit contact reference/source.mp4 --scenes reference/scenes.json -o reference/shots.jpg
media-edit contact renders/v03.mp4 --every 2                        # one frame every 2 s
```

`scenes` finds hard cuts reliably (5/5 on a synthetic edit); dissolves and graphics fading in are
missed, so look at the contact sheet. Read the contact JPEG to check framing, captions and black
frames.

## Other preinstalled tools and their rules

- Python: `python3` is the image's venv with numpy, scipy, opencv-python-headless 4.14 (with
  `cv2.FaceDetectorYN`; OpenCV 5 code and Haar cascades do not apply), faster-whisper 1.2.1, av 15,
  librosa, scenedetect, pillow, jieba, python-docx, openpyxl, xlrd, python-pptx. Install anything
  else with `uv pip install --python "$(command -v python3)" <pkg>` (or a fresh `uv venv`), never
  `pip`. Do not upgrade `av` (PyAV 16 breaks faster-whisper).
- Models: `/opt/media/models` (`whisper/small`, `whisper/large-v3-turbo`, `yunet.onnx`,
  `rnnoise-sh.rnnn`) — offline, no download needed.
- ffmpeg 8 with libass, drawtext, arnndn, frei0r (plugins installed), vidstab, zscale. Bloom/glow
  (`split` + `gblur` + `blend=screen`) must run in RGB: put `format=gbrp` before the split,
  otherwise the picture turns magenta. Text filters need a font file:
  `fc-match -f '%{file}' 'Noto Sans CJK SC:bold'`.
- ImageMagick 7 (`magick`), `rsvg-convert`, `vips`: pass a font **file path**
  (`-font /usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc`); a font name fails.
- `tesseract` with `eng`, `chi_sim`, `kor` for rough OCR (`tesseract frame.png - -l chi_sim+eng`);
  read frames yourself for anything that matters.
- `pandoc`, `zip`, python-docx for scripts, shot lists and hand-off packages.
- Attached documents: `pdftotext -raw` / `pdftoppm -png` (PDF), `catdoc -d utf-8` (.doc),
  `catppt -d utf-8` (.ppt), python-docx (.docx), xlrd (.xls), openpyxl (.xlsx), python-pptx (.pptx).
- `bc`, `file`, `/usr/bin/time -v` (time and peak memory of a command), and ghostscript (`gs`, e.g.
  PDF pages to PNG: `gs -sDEVICE=png16m -r150 -o page-%02d.png in.pdf`).
- Remotion (`/opt/media/remotion-starter`) also has @remotion/lottie, three, transitions, paths,
  noise, shapes, google-fonts, media-parser, plus three, @react-three/fiber, lottie-web and
  puppeteer-core. Anything with `@remotion/three` must render with `--gl=swangle` (the only GL mode
  that works without a GPU; about 5x slower than a GPU). `@remotion/google-fonts` needs the network
  at render time; prefer the installed Noto fonts.
