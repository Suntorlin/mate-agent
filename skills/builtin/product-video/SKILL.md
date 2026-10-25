---
name: product-video
description:
  Make a 10–30 s product video with voice-over from the user's real product photos (or, for
  software, their screenshots and page) - hook, demo, proof, call to action - where the product in
  every shot is the user's actual product, not a look-alike. Covers physical products (photos as
  references for generated shots) and apps / AI tools / launches (motion graphics from real
  screens). Use for "make an ad for this", product promo, launch video, listing video. NOT for
  copying one reference ad's structure (use viral-remake), and not for making many versions of a
  finished ad (use ad-variants afterwards).
---

# product-video

```bash
PV="${CLAUDE_CONFIG_DIR:-$HOME/.openinspect/claude}/skills/product-video"
mkdir -p /workspace/project-<slug> && cp -n "$PV/template/story.json" /workspace/project-<slug>/
python3 "$PV/scripts/story.py" check    /workspace/project-<slug>            # lines, voice price
python3 "$PV/scripts/story.py" timeline /workspace/project-<slug> --draft    # animatic with real voice
python3 "$PV/scripts/story.py" verify   /workspace/project-<slug>
python3 "$PV/scripts/story.py" timeline /workspace/project-<slug>            # → timeline.json for render
```

Talk to the user in the language of their latest message. Generation follows the product's own
generation tools (their cost and approval rules); rendering, captions, loudness, QA and publishing
follow `viral-remake` sections 4a–6. Check the library and memory first (colours, logo, voice, tone,
things to avoid).

## Two rules that decide whether the ad is usable

1. **It is their product.** Every shot showing the product is made from the user's own photo: as a
   reference image for the video model, as the start frame, or as the photo itself. Never t2i or t2v
   a product from its description: the result is a similar product, and an ad for a similar product
   is worthless. If the user gave no photo or screenshot, ask for one before anything else.
2. **Only their claims.** `facts` in `story.json` lists what the user said or their page states;
   every spoken line and on-screen number must trace to one of them. No invented specifications,
   prices, ratings, awards or "#1".

## Stages

| #   | stage    | output                                                                  | gate                                       |
| --- | -------- | ----------------------------------------------------------------------- | ------------------------------------------ |
| 1   | Intake   | product photos in `assets/`, `facts`, length, format, where it will run | ask once for what is missing               |
| 2   | Script   | `story.json` (hook → demo → proof → CTA), `check` clean                 | **user confirms** script and cost estimate |
| 3   | Voice    | one clip per line, `trim`, `verify`                                     | -                                          |
| 4   | Animatic | `timeline --draft` rendered                                             | self-check: pace, length                   |
| 5   | Shots    | clips sized by `cues.json`                                              | product check on a contact sheet           |
| 6   | Render   | `render`, loudness, QA, `media-preview`                                 | deliver, then offer `ad-variants`          |

### 1. Intake

- Look at every photo. Write a canonical description once and reuse it in every prompt: what it is,
  proportions relative to a hand, materials, colours, the visible mechanism, which faces carry text
  or a logo, and what you cannot see (do not invent the back of a product shown from the front).
- Clean photo for references: the product alone, no watermark or marketplace text
  (`generate_image_edit`: "keep the product exactly, remove the background text and badges, plain
  light backdrop"). Compare the result with the original before using it.
- Defaults when the user does not say: 9:16, 15 s, their language, a voice from the brand kit.

### 2. Script

| role  | length                  | what it does                                                             |
| ----- | ----------------------- | ------------------------------------------------------------------------ |
| hook  | 1.5–3 s                 | the buyer's problem or the most striking use, plus `hook.text` on screen |
| demo  | 3–8 s, one or two shots | the product doing its job, close enough to see how                       |
| proof | 2–5 s                   | the result, one number or fact as on-screen text                         |
| CTA   | 2–3 s                   | the real product photo, brand, what to do now                            |

One line per shot, each under 6 s; total voice about 2.5 English words or 4–5 Chinese / 6 Japanese
characters per second. `story.py check` prints the estimated length. Show the script with the cost
estimate the generation tools give before generating whenever it is large or the brief left the
angle open.

### 3–4. Voice and animatic

One text-to-speech call per line from `tts_jobs.json`, at most 4 in flight; `story.py trim`, then
`story.py verify` (a clip that speaks the wrong line fails here, not in front of the user). Render
the `--draft` timeline and listen once: the voice sets every shot's length, so fix the script now.

### 5. Shots: physical product

Pick per shot, cheapest first; `cues.json` says how many seconds each shot needs.

| shot                                  | how                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| CTA, pack shot                        | the user's photo (or its cleaned edit) with Ken Burns: free, and exact                       |
| product in a scene, no motion needed  | image edit of the photo ("keep this exact product; place it on …"), Ken Burns                |
| product in use, hands, motion         | **reference-to-video**: the clean product photo(s) as `ref` inputs, the action in the prompt |
| the shot must start on an exact frame | image edit keyframe → `i2v` from that keyframe                                               |

- Reference-to-video is the default for motion: pick a video model the product's generation tools
  offer that takes reference images, check how many references it takes and its durations, and pass
  the clean product photos as references (several angles of the same product help). A model may also
  take a start frame together with references.
- If no model takes references, use keyframe → `i2v` for every motion shot. Do not feed a
  multi-panel storyboard as a start frame: the panels stay visible in the video.
- Prompt each shot as one continuous action with framing and hands stated ("close-up, one hand
  enters from the right and presses the lid; the lid clicks open"). Say "no text, no captions, no
  watermark, no extra hands"; put all text in the timeline, never in a generation prompt.
- **Product check before rendering:** `media-edit contact` each clip (or tile first / middle / last
  frames) beside the original photo. Reject a clip when the shape, colour, logo, label text or
  number of parts changed; retry once with a tighter prompt, then fall back to the photo with Ken
  Burns for that shot and tell the user.

### 5b. Shots: software, apps, launches

No generated footage of screens: models redraw UI text as nonsense. Build the shots from the real
screens instead.

- Screenshots from the user, or of their page (`viral-remake`'s `screenshot_page.sh`). Crop to the
  part that matters and zoom until its text is readable at phone size (at least 42 px on a 1080-wide
  frame after the zoom).
- Simple cut: each screen is a still with Ken Burns into the detail the line talks about, with a
  `label` text for the benefit. This runs straight through `story.py timeline`.
- Designed launch film (typed prompt, cursor demo, count-up numbers, logo build): use the
  motion-graphics kit of `viral-remake` section 4b, with the voice lines from this project placed
  first and each beat sized to its line. One new visual event every 1.5–3 s; nothing static longer
  than 0.5 s except a deliberate hold; render stills of each beat and look before the full render.

### 6. Render and deliver

`story.py timeline` (fails when a clip is shorter than its voiced shot),
`render timeline.json renders/v01.mp4`, `media-edit loudness`, `viral-remake`'s QA, `media-preview`.
Music: the user's track or `viral-remake`'s `make_music.py`. Report the length, the cost, which
shots are generated and which are the user's photos, and any claim you left out for lack of a
source. Save the cleaned product photo with `library put`. Then offer more hooks, headlines and
sizes with `ad-variants`: they reuse this project and cost almost nothing.

## Gotchas

| symptom                                           | cause                               | fix                                                 |
| ------------------------------------------------- | ----------------------------------- | --------------------------------------------------- |
| the product looks slightly different in each shot | t2v / t2i from a description        | references or start frame from the real photo       |
| storyboard panels visible in the video            | a board used as the start frame     | references, or one keyframe per shot                |
| logo or label text is garbled                     | the model redrew it                 | product check; fall back to the photo for that shot |
| a number on screen the user never gave            | invented proof                      | `facts` only                                        |
| the voice runs past the cut                       | shot timed before the voice existed | `story.py timeline` sizes shots from the audio      |
| UI text is nonsense                               | generated screen footage            | real screenshots, path 5b                           |
