---
name: long-scroll-film
description:
  Make a 30–60 s "walk through the eras" film drawn entirely in code - one hero walks left to right
  across a chain of worlds (game generations, art movements, decades, product versions), the world
  and the hero restyle at every border, and each world plays one voiced beat with generated voices.
  No image or video generation. Use for "history of X in one minute", "through the ages", retro /
  pixel / nostalgia formats, era-hopping brand stories. NOT for photoreal footage or a real person's
  likeness, and NOT for copying one reference video (use viral-remake).
---

# long-scroll-film

```bash
LSF="${CLAUDE_CONFIG_DIR:-$HOME/.openinspect/claude}/skills/long-scroll-film"
bash "$LSF/scripts/new_film.sh" /workspace/project-<slug>      # scaffold (engine, example worlds, score)
node "$LSF/scripts/render.mjs" /workspace/project-<slug> --stills 2,6,12
node "$LSF/scripts/render.mjs" /workspace/project-<slug> --video out/film.mp4
python3 "$LSF/scripts/mix.py" /workspace/project-<slug>        # → out/mix.wav (−14 LUFS)
```

Talk to the user in the language of their latest message.

## The law

**The voice sets the clock.** Each world's stop lasts exactly as long as its lines; walking is only
the cut between beats. The engine reads every line's length from `audio/voice/<id>.mp3`, so lock the
lines first and re-render after any voice change - never hand-tune animation timing to a guessed
length.

Code is free; voices are cheap. A whole 53 s film used no image or video generation. Generate media
only for what code cannot draw (photoreal people), with the product's generation tools.

## What makes it land

The payoff is a voice. Each world borrows a period voice (an arcade announcer, an RPG king, a
professor, a mascot cry) and the last world gives the hero a voice of their own. Silence is a beat
too: a hero who only ever answers 「はい」 or 「……」 makes the first spoken line land.

## Stages

| #   | stage           | output                                                                 | gate                                      |
| --- | --------------- | ---------------------------------------------------------------------- | ----------------------------------------- |
| 1   | Script in text  | worlds (5–8), one beat + one line each, voice per role                 | **user confirms** (expect several rounds) |
| 2   | One frame first | the most recognisable stop, hero in 3 directions, `media-preview` each | **user picks**                            |
| 3   | Worlds          | `film/worlds.js`, stills of every stop                                 | self-check (contact sheet)                |
| 4   | Voices          | audition the hero (2 voices), then every line; transcribe each clip    | -                                         |
| 5   | Render + mix    | `out/film.mp4` + `out/mix.wav` → muxed final                           | deliver with `media-preview`              |

### 1. Script

- One world = enter → one line → one action → leave. A second line only for the punchline.
- **Escalate:** worlds get shorter and faster toward the climax (raise `v` per world, e.g. 950 →
  1450 px/s), then the last world slows hard (`v` 700, 0.6 s before and 1.0 s between its lines).
  The same walk-stop-talk rhythm repeated reads as a slideshow.
- Pick worlds recognisable from one frame. If the user says "not typical enough", go more canonical.
- Public or client work: genre conventions only (a dialogue box, a pixel cave, a battle menu) - no
  real characters, logos or melodies. Real IP only for the user's internal use, on their explicit
  word.
- In `film/lines.js` keep **spoken text** (`ja`/…), **caption** (`zh`/…) and **dialogue-box text**
  (`box`) separate: 「……」, quotes and ellipses are silent in TTS and can swallow a neighbouring
  word.

### 2. One frame first

Render one stop with the hero three ways - the canonical look, one original hero who persists across
worlds, a brand mascot - with `--stills`, and show full frames plus a 2× nearest-neighbour crop
(`ffmpeg -vf "crop=…,scale=iw*2:ih*2:flags=neighbor"`); pixel art is unreadable as a thumbnail.

### 3. Worlds (`film/worlds.js`; interface in `references/engine.md`)

- Pixel worlds: draw on 240×135, the engine scales ×8; dialogue on a 480×270 pixel layer
  (`FILM.ptext`, `FILM.typed`). Flat-vector / low-poly worlds draw full-res in `draw(c, s)`.
- Time every event from `FILM.cue('<id>').T`, never from "seconds after entering".
- Frame each stop so the next world stays out of shot while anyone talks:
  `w ≥ max(camAt, stop − 720) + 1980` (the camera never moves back).
- Keep each icon's signature colour even inside a restricted palette (a yellow mascot in a green
  Game Boy world); without it the sprite is not recognised.
- Contact-sheet every stop: `--stills` at each cue +
  `ffmpeg -pattern_type glob -i 'out/stills/t*.png' -vf "scale=640:-1,tile=3x3" sheet.png`, then
  look at it.

### 4. Voices (with the product's voice tools)

- Cast with the product's voice search (by language, popularity or an attitude word); skip voices
  named after real people, idols, voice actors **or anime/game characters**.
- Audition the hero on the two key lines with two voices; prefer the one whose pause lands the joke.
- One text-to-speech call per line, **one at a time or at most 4 in flight**; save each result to
  `audio/voice/<line id>.mp3`, following the tool's own cost and approval rules.
- Trim edge silence (TTS adds 0.3–1 s):
  `ffmpeg -i in.mp3 -af "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse" out.mp3`.
- **Transcribe every clip** (`media-edit transcribe`) and compare with the line before rendering. In
  the first run 5 of 9 clips said the wrong line (parallel calls shared one request file); only the
  transcripts caught it.
- Before voices exist you may time the cut with a free placeholder; say plainly it is a placeholder.

### 5. Render, mix, deliver

`audio/score.json`: one loop per world (original melodies), signature jingles on cues, typing blips
per dialogue line; `mix.py` ducks music under voices and normalises to −14 LUFS. Then
`ffmpeg -i out/film.mp4 -i out/mix.wav -c:v copy -c:a aac -b:a 192k -shortest out/final.mp4`, check
loudness (`ebur128`), and `media-preview out/final.mp4 "<title>"`. 1920×1080 at 30 fps renders at
roughly 8–10 frames/s.

## Gotchas (measured, 2026-10-07)

| symptom                                     | cause                                 | fix                                             |
| ------------------------------------------- | ------------------------------------- | ----------------------------------------------- |
| several clips say the same line             | parallel TTS sharing one request file | sequential / unique files; transcribe each clip |
| `rate_limited` from TTS                     | ~9 requests at once                   | ≤ 4 in flight, retry failures                   |
| 「はい」と「……」 spoken as 「はい、しか」   | ellipsis silent, particle swallowed   | separate spoken text and caption                |
| next world visible during dialogue          | camera never goes back                | widen the world (rule above)                    |
| dialogue box stays while walking away       | UI drawn after the cue                | engine draws `ui`/`over` only during the stop   |
| a beat's prop never appears                 | beat without `dur`                    | every beat in `script` needs `dur`              |
| a mascot reads as a goblin                  | 4-shade palette, side view            | front view, keep its signature colour           |
| `▶` cursor missing                          | pixel font lacks the glyph            | draw the triangle                               |
| user assumed the placeholder voice was real | not named                             | name it on first delivery                       |
