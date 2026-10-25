---
name: viral-remake
description:
  Remake the structure of a reference short video (Instagram Reel incl. 16:9 ads, TikTok, YouTube
  Short) for the user's product or brief, or make a new 9:16 video from a brief. Analyzes the
  reference's shots, hook, captions and pacing, writes a storyboard, generates assets with the
  product's media tools, renders with the preinstalled Remotion timeline renderer, runs QA,
  publishes the MP4 as a session artifact and hands the project over as a download on request.
---

# viral-remake

Copy the reference's **structure** (shot count, shot lengths, hook in the first 1–2 s, caption
style, pacing), never its content: do not reuse its footage, voice, music, logos or exact script.
All media comes from the generation tools the product provides (its MCP tools for images, video,
voice), from files the user supplied, or from ffmpeg/Remotion; without generation tools, build the
video from the user's files and local tools.

The user's files are in `/workspace/inputs/` (attached to their messages) and `/workspace/library/`
(their asset library: `library ls`, `get <name>`, `put <file>`). Before choosing fonts, colors,
logo, intro/outro or voice, check the library and memory (the user's profile: tone, visual style,
aspect ratio, caption and music style, things to avoid) and follow them unless the user asks
otherwise.

Tools in the image: `ffmpeg`/`ffprobe`, `render` (Remotion starter at `/opt/media/remotion-starter`,
renders offline on every CPU — sessions get 8), `media-edit` (the media-edit skill: captions,
jumpcut, reframe, beatcut, voice, loudness, scenes, contact; read it before editing footage and for
the rules of the other preinstalled tools), and this skill's scripts:

```bash
VR="${CLAUDE_CONFIG_DIR:-$HOME/.openinspect/claude}/skills/viral-remake/scripts"
```

Timeline format: [references/timeline-format.md](references/timeline-format.md).

## Quality bar (hard rules; the remake is not done until all hold)

1. Talk to the user in the language of their latest message: every progress line, question, preview
   title and the final summary (a Chinese message gets Chinese progress lines), whatever language
   the video, the reference, the tools or this skill are in.
2. One recurring hero = one character sheet. Every keyframe that shows the hero is an image **edit**
   with the sheet as its input image — never text-to-image (it draws a different person every time).
   Before any i2v, run `qa_edit.sh`'s keyframe contact sheet (or tile the keyframes yourself), look
   at it, and regenerate any keyframe whose face, hair or outfit differs.
3. Replicate the reference's motion-design language, not only its beats: list every graphic element
   per shot (type, position, motion, duration) in storyboard.md and give each a counterpart.
   Graphics the actor interacts with go INTO the keyframe (image edit: "keep the photo, add glowing
   pixel-art <sprite> floating beside her") and the i2v prompt makes her react/touch it — never a
   post overlay. Tool-at-work beats show an editor UI (canvas + layer timeline + keyframes + cursor)
   with camera moves; deliverables (maps, posters, badges) are real illustrations (generated) with
   labels, pins and selection boxes animated on top.
4. Keep the reference's action beats: at least two live-action motion set pieces with the hero
   (running, rushing, chasing) placed where the reference has its action.
5. Pacing: no static segment longer than 4 s; after the final twist beat the end card lasts ≤ 3 s;
   total 45–60 s unless the user asked otherwise.
6. Motion-graphics beats are full-frame designed screens at the kit's scale (LogoBuild,
   VoiceCasting, MarketMap), never a small card floating on an empty background.
7. `media-edit loudness renders/vNN.mp4 -o renders/vNN.final.mp4` must report `"pass": true` (-14
   LUFS, true peak ≤ -1.0 dBTP measured after encoding), then
   `bash "$VR/qa_edit.sh" renders/vNN.final.mp4 assets/keyframes` must print `QA PASS` (no black
   > 0.3 s, no freeze > 1.5 s before the last 3 s, loudness −16…−14 LUFS), and you must look at both
   > contact sheets it writes before publishing the `.final.mp4`.
8. Time box (for the user's sake, not the sandbox's): all generations submitted by minute 15, first
   full render by minute 30, publish by minute 38 — if QA still fails then, publish the best render
   anyway, list the failing checks in your reply, and fix in the next prompt. An unpublished perfect
   render is worth nothing to the user. The sandbox has no countdown: it keeps running as long as
   you are working; when the session sits idle it is saved and resumes in seconds on the user's next
   message, with every file intact but no running processes (restart background renders or servers;
   keep state in files such as progress.md). Never tell the user how many minutes the sandbox has
   left, that it will close, or that later edits need a new session.
9. Show the work as it goes: the plan in the todo tool
   (e.g. 拆解参考视频 → 写分镜 → 生成素材 → 配乐和旁白 → 剪辑渲染 → 检查并发布), one update per
   stage; storyboard frames of the first draft and the music you made on the canvas (section 6); the
   final cut published last.
10. Memory records what actually happened (e.g. "keyframes were t2i and the face drifted"), not what
    was intended; check remembered lessons against the contact sheets.

## Project folder (survives across prompts)

```
/workspace/project/
  progress.md        stage checklist, decisions, ids: read it FIRST on every prompt
  storyboard.md      the plan the user can read
  shots.json         planned shots (mirrors reference/shots.json)
  timeline.json      what gets rendered
  reference/         source.mp4, meta.json, shots.json, keyframes/, contact.jpg, audio.m4a, transcript.txt
  assets/            s01.png, s02.mp4, vo_01.mp3, music.mp3, logo.png … (one file per use)
  renders/           v01.mp4, v02.mp4 … and QA frames
```

When a prompt arrives, `cat /workspace/project/progress.md` and continue from the first unchecked
stage; if the user asks for a different video, start `/workspace/project-<slug>/` instead of
overwriting. Update progress.md after every stage: what was done, generation ids and results, open
questions. Keep it short.

## 1. Analyze the reference

Put the reference at `reference/source.mp4`: copy a file the user placed in the workspace,
`curl -fL` a direct media URL, or for an Instagram link:

```bash
python3 "$VR/fetch_reel.py" "<instagram reel url>" reference/source.mp4   # no login needed
```

Keep the reference's aspect ratio for the remake (set `canvas.width/height`; a 16:9 reel stays 16:9)
unless the user asks for another format.

```bash
python3 "$VR/analyze_reference.py" reference/source.mp4 reference/
```

It prints a shot table and writes `meta.json`, `shots.json`, one keyframe per shot, `contact.jpg`
and `audio.m4a`. Then:

- Look at `reference/contact.jpg` and `reference/keyframes/hook.jpg` (Read the images). Note per
  shot: framing (close-up/wide/product/face/screen), motion, on-screen text (wording, position,
  style: bold outlined hook, word-highlight captions, labels), and what the shot does (hook,
  problem, demo, proof, CTA).
- Each shot's `transition_in` is `cut` or `dissolve` (a crossfade, located to about ±0.3 s); mirror
  it with `transition: {type: "crossfade"}` in the timeline. If the contact sheet shows two scenes
  in one shot, or one scene split in two (fast camera motion), re-run with a lower or higher
  `--threshold` (hard cuts, default 0.3) / `--fade-threshold` (dissolves, default 0.25).
- Transcript: `media-edit transcribe reference/audio.m4a -o reference/words.json` (offline, free,
  word timing; Chinese gets simplified characters) and save its text as `reference/transcript.txt`;
  the word timing also shows the reference's caption rhythm. If there is no speech, write down the
  on-screen text instead.

## 2. Storyboard

Two kinds of reference need different plans:

- **Montage / talking-head / product reels**: mirror the shot table exactly (rules below) and render
  with `render` (timeline.json).
- **Narrative ads with UI inserts** (a hero, a brief arriving, the product's screens, action beats,
  "send it to the client", end card — e.g. Higgsfield-style promos): keep the _beat sheet_ (order,
  rhythm, which beats are live action vs. motion graphics), write a new story and hero when the user
  asks for a different creative, and render with the motion-graphics kit (section 4b).

Write `storyboard.md` (a table: shot, time, duration, visual, on-screen text, voiceover line, asset
source) and `shots.json`. Rules:

- Same number of shots as the reference and each duration within ±20% of it, unless the user asked
  otherwise; total length within ±10%. Plan the cut points on the reference's times: a shot's
  `duration` is the time until the next shot starts, crossfades included.
- The hook must land in the first 1–2 s: a bold `hook` text plus the most striking visual.
- Mirror the caption style (word-highlight captions if the reference has them) and pacing.
- Adapt the subject, script and visuals to the user's brief, product and what memory says about them
  (the memory block: profile, preferences, lessons, recent projects; `mem search <words>` finds
  older ones, see the `memory` skill).
- Voiceover: one line per shot or caption group, short enough to fit the shot (about 2.5 English
  words or 4–5 Chinese characters per second).
- For each shot pick the cheapest asset that works: a user photo, a generated still with Ken Burns,
  an image edit of the product photo, or a generated video clip. Put text in Remotion, not in
  generation prompts.

For a recurring character, plan the consistency chain up front: character sheet → one keyframe per
shot (image **edit** with the sheet as input) → i2v per keyframe (see section 3).

Show the storyboard and the estimated cost to the user before generating if the brief is ambiguous
or the generation is expensive; otherwise proceed. When it has a script, publish `storyboard.md` as
a document (`media-preview storyboard.md "脚本与分镜表"`) with the first frames you publish.

To check how an HTML storyboard or shot list looks, screenshot it with
`bash "$VR/screenshot_page.sh" storyboard.html renders/storyboard.png [width] [height]`
(agent-browser, full page, about 2–10 s, killed after 60 s). Do not use Chrome's own
`--headless --screenshot`: it never finishes in this sandbox. Any other browser command
(`agent-browser …`) must run under `timeout 60` too. Never `pkill -f chrome`: the pattern matches
your own Bash command and kills it.

## 3. Generate assets

Generate media with whatever generation tool the product provides (its MCP tools); if there is none,
use the user's files and local tools (ffmpeg, Remotion, Blender). Follow the tools' own instructions
for models, cost and approval, submit all shots before waiting on any, and download results into
`assets/`. Animate a generated or uploaded still instead of generating twice. Generate the voiceover
per line, `ffprobe` each file for its duration, and place lines on the timeline at their shot
starts.

Music and SFX: a track the user supplied, one the product's tools make, or an original bed
synthesized in the sandbox:

```bash
python3 "$VR/make_music.py" --out-dir assets/audio --duration 57 \
  --sections intro=0,groove=4,build=29,drop=39.6,adbreak=43.6,outro=48 --impacts 4,39.6,51
```

Place section starts on your beat sheet (drop on the biggest cut, `adbreak` under a voiceover) and
use the `sfx_*.wav` it writes for whooshes, pops, key clicks, notifications and the final ding.

- Consistency comes from keyframes: character sheet → one keyframe per shot (image edit with the
  sheet as input) → one image-to-video clip per keyframe.
- Image models draw real brands (convenience-store stripes, laptop logos): say "generic, unbranded,
  plain signage, no logos"; if one survives, `ffmpeg -vf delogo=...` the keyframe before animating.
- Look at a 3-frame strip of every clip before editing and trim bad tails.
- Skip celebrity-clone voices; use generic voices.

Captions come from the real voiceover audio with `media-edit captions` (ASR word timing, lines
broken by rendered width, Chinese split into words): for each voiceover file, with `--offset` set to
where it starts on the timeline,

```bash
media-edit captions assets/vo_01.mp3 --offset 2.5 -o assets/captions/vo_01   # --lang zh for Chinese
```

and paste the entries of every `assets/captions/vo_NN.remotion.json` into `timeline.captions` (add
`style`/`position` to match the reference). Check the words against the script and fix any
mishearing in the JSON. To caption user footage or a finished render instead, burn them in:
`media-edit captions renders/v02.mp4 --burn -o renders/v02.captions`. Fallback without audio
(estimated timing): `python3 "$VR/caption_words.py" lines.json > captions.json`.

## 4a. Montage path: build timeline.json and render

Write `timeline.json` from `shots.json` (see the format reference), then:

```bash
cd /workspace/project && render timeline.json renders/v01.mp4
```

Fix every `Invalid timeline` error it prints and consider every `warning:` (a clip shorter than its
shot freezes on its last frame). A 30 s 1080x1920 render takes on the order of a minute.

## 4b. Narrative / motion-graphics path

```bash
bash "$VR/new_edit_project.sh" /workspace/project/edit
```

It copies the kit (`references/mg-kit/src`: shot sequencing with trims, title, messenger bubbles,
typing prompt bar with key clicks, status card with shimmer, logo build with code chips, mascot pop,
voice-casting screen with a real waveform, neon map with route + photo cards, render progress card,
mini-ad with voiceover, end card; music ducking under VO) and links the starter's node_modules. Edit
`src/Main.tsx` (SHOTS table, overlays, SFX list) and the copy/strings in `src/scenes.tsx` for the
new story; hard-link or copy media into `public/`. Render stills first
(`npx --no-install remotion still src/index.ts Main renders/f.jpg --frame=<n>`) at each beat, look
at them, publish 3–8 of them in one call as the storyboard ("分镜 1 · 开场", …), then render the
full video with `--concurrency=8` (all 8 vCPUs; Remotion's default uses half): a 56 s 1080x1920 cut
takes about 70 s. Fonts are local (Noto Sans CJK); never import Google fonts (the sandbox renders
offline). Symbols outside those fonts, such as ❚❚ (pause) or ⌕ (search), render as empty boxes: draw
icons as inline SVG. Keep JSX string literals in straight ASCII quotes: typographic quotes (“ ” ‘ ’,
including inside Korean/Chinese copy) as string delimiters break the esbuild bundle — put them
inside the text or use `&ldquo;`/`&rdquo;`. Replace every placeholder string from the kit (the kit
is a previous project's story) and grep for it before rendering.

For a vertical (1080x1920) motion-graphics cut, generate and place the voiceover first and size each
shot to its line's length (`ffprobe`), rather than fitting lines into shots timed in advance.

## 5. QA, fix, re-render

Both paths: normalize first, `media-edit loudness renders/v01.mp4 -o renders/v01.final.mp4` (Quality
bar 7), and run the checks on the `.final.mp4`. Narrative path:
`bash "$VR/qa_edit.sh" renders/v01.final.mp4 assets/keyframes`. Montage path:

```bash
python3 "$VR/qa.py" renders/v01.final.mp4 timeline.json --reference-shots reference/shots.json
```

For the narrative path the shot-count/±20% check is advisory when the user asked for a new creative;
still require duration, codec, audio, legible text and no black/frozen gaps
(`ffmpeg -vf blackdetect,freezedetect`) and the `media-edit loudness` pass.

It checks the canvas size, H.264 yuv420p, duration within 0.1 s of the timeline, audio present, shot
count and ±20% shot durations, and extracts hook/middle/end frames. Read the three PNGs and check:
text legible and inside the safe area, nothing cut off, Chinese/emoji glyphs render, the hook reads
in the first second, no black gaps. Audio: each voiceover line must end before its shot ends
(compare `ffprobe` durations with the timeline). Fix the timeline or regenerate a shot, render as
`v02.mp4`, and repeat until QA passes. Never publish a render that failed QA without telling the
user why.

## 6. Publish

After the first full render, if no storyboard frames are on the canvas yet, grab one frame from the
middle of each shot of `v01` and publish them with the music bed you synthesized (preview skill,
"Show the process"); then the final cut, last, in the same call or right after:

```bash
media-preview review/shot1.jpg "分镜 1 · 开场" review/shot2.jpg "分镜 2 · 产品" … \
  assets/audio/music.wav "配乐" renders/v02.final.mp4 "<a few words in the user's language, e.g. 成片 v2>"
```

A revision is the same title with the next number ("成片 v3"), and your line about it says what
changed; its frames and music go up again only when they changed.

It opens the video in the user's preview pane (preview skill), reading duration, frame size and
audio with ffprobe, and prints JSON with an `artifactId`. Previews: H.264 MP4, at most 10 minutes
and 1 GB, 200 videos per session. Masters in another codec (ProRes, HEVC, alpha), larger or longer
cuts and any other deliverable (captions, stems, FCPXML/EDL, PDF) go over as downloads:
`media-preview --file <path> "<title>"`. Report the `artifactId` and the final duration. Do not
claim the video was published unless an `artifactId` came back.

When the user asks for the project or source files, or wants to continue in their own editor, run
`media-export /workspace/project "<项目名>"`: it zips sources, timeline, captions, stems, renders
and editing-app files, and the preview pane shows "Download project". Do not offer it unprompted
when a video is done.

## 7. Remember

Once the user has the video, record it (memory skill):
`mem set project.<yyyy-mm-dd>.<name> "<topic, length and format, look, models and voice, what the user thought>"`,
and `mem set lesson.<topic> "…"` for anything that worked or failed for this user in particular.
Save reusable files (logo, character sheet, product shots) with `library put <file>`.
