---
name: preview
description:
  Show the user something in the preview pane and canvas next to the chat — a finished or draft
  video, storyboard frames, music or a voice-over to play, a brief to read, a web page — and hand
  over files to download (masters in any codec, editing-app project files, the whole project as a
  zip). Use whenever there is something for the user to look at, listen to or take away, and to show
  the steps of a creative job as it goes; never ask them to open sandbox paths.
---

# preview

The pane to the right of the chat is yours: whatever you publish there opens as a tab, and the
newest one is shown. Files to download are listed there too. Publish with the `media-preview`
command (on PATH):

```bash
media-preview renders/v02.mp4 "成片 v2"
media-preview review/keyframes.jpg "Keyframes"
media-preview storyboard.html "Storyboard"
media-preview audio/music.mp3 "配乐"
media-preview handoff/edit.fcpxml "Final Cut 工程"
media-preview --file renders/master_prores.mov "母版 ProRes"
media-export /workspace/project "项目文件"
```

Several files go in one call as `<file> "<title>"` pairs (`--file` before a pair makes that one a
download), published in the order given; every pair is checked first, so a bad one publishes
nothing. Publish what belongs together in one call rather than one call each:

```bash
media-preview review/shot1.jpg "分镜 1 · 开场" review/shot2.jpg "分镜 2 · 产品特写" \
  review/shot3.jpg "分镜 3 · 结尾" audio/music.mp3 "配乐" renders/v01.final.mp4 "成片 v1"
```

**Did it work? Read the exit code, not the JSON.** Exit 0 means every pair is published; the last
line of output says so in words —
`published 5/5: 分镜 1 · 开场, 分镜 2 · 产品特写, 分镜 3 · 结尾, 配乐, 成片 v1`. Exit 1 means some
were not: the last line counts them (`published 4/5: ...`) and the error names each title that
failed — publish only those again. Never republish after exit 0, and do not count or grep the JSON
to decide. Above the summary is one line of JSON per pair with its `artifactId` and `title`.
Publishing the same file again (same bytes, file name and title) in this session uploads nothing: it
returns the artifact it already became, marked `"alreadyPublished":true`, so a repeat never makes a
second card. A new version is new content or a new title.

**Preview** (plays or shows in the pane):

- **Video**: H.264 MP4 (with or without audio), at most 10 minutes and 1 GB, 200 per session.
  Duration, frame size and audio are read with ffprobe. 4K and long cuts play, but keep previews
  light (CRF 23–28, `-movflags +faststart`) so they start at once.
- **Image**: PNG, JPEG or WebP, at most 10 MB.
- **Audio**: MP3, WAV, M4A, AAC, OGG/Opus or FLAC gets its own tab with a player and waveform (the
  waveform up to 25 MB: a long WAV goes in as MP3 or M4A).
- **Document**: Markdown (`.md`) and plain text are read in place; a PDF opens in the viewer.
- **Page**: one self-contained HTML file, at most 10 MB, 50 per session. Inline its CSS and scripts;
  images go in as `data:` URIs or `https://` URLs. It runs sandboxed in its own origin: no cookies,
  no forms, no requests to the sandbox, links open in a new tab. Use a page when a layout says more
  than a single image: storyboards, shot lists with frames, side-by-side cuts.

**Download** (listed in the pane with name, size and a download button):

- Any other file becomes a download: DOCX, CSV, ZIP, FCPXML / Premiere XML / EDL / OTIO,
  ProRes/HEVC/VP9 `.mov`/`.webm`/`.mkv`, SRT/VTT captions, `.cube` LUTs (audio and documents above
  can be downloaded too). Up to 4 GB each, 200 per session; the file keeps its name.
- `--file` hands over a previewable file as a download instead: the full-quality master `.mp4`, a
  full-resolution still.
- Preview and delivery are separate: deliver masters (any codec, 4K, long, alpha) as files, and
  publish an H.264 preview of the same cut for watching.

`media-export [folder] ["<title>"]` zips a whole project folder (default `/workspace/project`):
sources, timeline, captions, audio stems, renders and editing-app project files, without
`node_modules` and caches. The pane offers the newest one as "Download project". Run it only when
the user asks — for the project or source files, or to continue in their own editor. A finished
video is not a reason to offer the zip, and the zip is never a default deliverable.

The title is the tab or file name the user sees: a few words in the user's language that say what it
is ("成片 v2", "Storyboard", "Final Cut 工程"), never a path, codec or other engineering detail. Do
not say something is in the preview or ready to download unless media-preview exited 0 (or its title
is in the `published` line).

**Show the process.** The canvas is where the user watches the work take shape: their references and
what you publish, versions in a row. What you make in the sandbox shows only when you publish it. In
a creative job (a video, an edit, a series of images), publish, in the user's language:

1. **Storyboard frames**, as soon as there is something to show and at the latest right after the
   first draft render: 3–8 images, one per planned or rendered shot, each titled by its shot
   ("分镜 1 · 开场", "分镜 2 · 产品特写"). They form the Storyboard tab. Take them from the draft
   render (one frame from the middle of each shot), a Remotion still
   (`npx --no-install remotion still src/index.ts Main review/shot1.jpg --frame=<n>`), a HyperFrames
   frame or a Blender still; do not republish generated media as it is.

   ```bash
   i=0; for t in 1.2 4.5 8.0 11.5 15.0; do i=$((i+1))   # the middle of each shot, from the timeline
     ffmpeg -v error -y -ss "$t" -i renders/v01.mp4 -frames:v 1 -vf scale=720:-2 -q:v 3 "review/shot$i.jpg"
   done
   ```

2. **Audio you made** that shapes the piece: the music bed you synthesized, the final voice-over mix
   ("配乐", "旁白混音"). Not every line or stem.
3. **Each revision as a new version**: the same title with the next number, then a short note of
   what changed after " · " ("成片 v1", then "成片 v2 · 开场换成产品特写"). The board matches titles
   up to the version mark, so v1 → v2 stay joined and the note shows on the card. Never reuse the
   old title for a new cut.
4. When the project has a script, optionally a short brief or shot list as a `.md` ("脚本与分镜表").

The final cut is published as before and is the **last video you publish in the turn**: the chat
shows the turn's last video as its result. Publish frames, audio and documents before it, or ahead
of it in the same call. Batch: one call for the storyboard frames (plus the music if it is ready),
one for the draft or final cut, not one call per file.

**Timeline.** When a video comes from a `timeline.json` (`render`), publish that timeline next to
the render, as a file named `*.timeline.json`:

```bash
media-preview renders/v02.mp4 "成片 v2"
cp project/timeline.json renders/v02.timeline.json && media-preview --file renders/v02.timeline.json "成片 v2 工程"
```

The pane shows it under the video it matches (same length): shots, text, captions and audio as
blocks the user can click to jump to, and comment on. Publish a new one with each render.

**Canvas.** The canvas arranges itself — you never have to write a layout file. Everything you
publish lands as a card on the board described above: versions named alike ("成片 v1", "成片 v2")
share a row with arrows between them, and the user pins comments anywhere. A `*.canvas.json`
replaces that board with yours (everything published, plus only the references it names), so publish
one only when a layout would say more than the lanes — options to choose from, or an arrangement the
user asked for:

```bash
cat > review/board.canvas.json <<'JSON'
{ "rows": [
    { "title": "分镜", "items": ["镜头 1", "镜头 2", "镜头 3"] },
    { "title": "成片", "items": ["成片 v1", "成片 v2"], "arrows": true }
  ],
  "from": { "成片 v1": ["镜头 1", "镜头 2", "镜头 3"] } }
JSON
media-preview --file review/board.canvas.json "画布"
```

- Rows run top to bottom, items left to right. An item is the exact title you published it with (a
  downloaded file's name works too). That is all there is — no positions, sizes, colours or version
  numbers; `title`, a one-line `note` beside it, and `arrows` (link each item to the next) are
  optional, and a name that matches nothing is skipped, never an error.
- `"from"` is lineage: for each thing, the things it was made from (the shots a cut was assembled
  from, the frame a cover was taken from). Things with lineage are laid out as a flow, sources on
  the left, results to their right, joined by lines. Record it whenever one published thing was made
  from others; `rows` and `from` each work alone.
- Publishing the file opens the Canvas. A new version of something already in a row joins it by
  itself, with an arrow — nothing to do for a revision. Publish again only when the rows change (the
  newest file replaces the last one); whatever it leaves out stays on the board, below.

**Review comments.** The user can pin comments on what you published: a moment and a spot in a
video, a spot in an image, a timeline block, a whole page, or the work as a whole (a note on the
canvas itself: no `artifactId`, just `n` and `text`). They arrive as one message: a numbered list in
their words, attached stills (the video frame or image with the comment's number drawn at the spot,
in comment order), and a `review-comments` JSON block:

```json
[
  {
    "n": 1,
    "artifactId": "…",
    "artifact": "成片 v2",
    "time": 12.4,
    "x": 0.32,
    "y": 0.18,
    "item": { "track": "shots", "index": 3, "label": "shot03", "start": 8, "end": 11.5 },
    "image": 1,
    "text": "这个镜头换成产品特写"
  }
]
```

`x` and `y` run 0–1 from the top left of the frame. `item.track` is the timeline array (`shots`,
`texts`, `captions`, `audio`) and `item.index` is 1-based into the timeline you published for that
video. Change only what the comments ask, render, publish the new version with a new title
("成片 v3") and its timeline, and answer each comment by number in one short line.

To look at a page yourself before publishing it, screenshot it with viral-remake's
`screenshot_page.sh` (agent-browser, full page, killed after 60 s) or `timeout 60 agent-browser …`.
Never Chrome's own `--headless --screenshot`: it hangs in this sandbox.

Publish when the user should look or listen: a storyboard before spending on it, keyframes before
animating them, storyboard frames of the first draft, the music and voice-over you made, each render
worth reviewing, and the final cut last. Do not publish intermediate files nobody needs to see
(every voice line, scratch renders, stems, caches).
