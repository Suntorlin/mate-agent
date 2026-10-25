---
name: ad-variants
description:
  Turn one finished ad into a set of versions to test - different hooks (a new first line, voice
  clip or opening shot for the first 2–3 s), different headlines (on-screen wording), and every size
  (9:16, 4:5, 1:1, 16:9) - rendered in one batch with consistent file names, a manifest and a
  contact sheet of all hooks. Works on a project made here (timeline.json) or on any finished MP4.
  Use for "give me 5 hooks", A/B versions, "resize for feed / stories / YouTube", ad sets. NOT for
  making the first ad (use product-video or viral-remake), and not for translating it.
---

# ad-variants

```bash
AV="${CLAUDE_CONFIG_DIR:-$HOME/.openinspect/claude}/skills/ad-variants"
python3 "$AV/scripts/variants.py" wrap   input.mp4 /workspace/project-<slug>   # only for a finished MP4
cp -n "$AV/template/variants.json" /workspace/project-<slug>/
python3 "$AV/scripts/variants.py" build  /workspace/project-<slug>    # → variants/<name>/timeline.json
python3 "$AV/scripts/variants.py" render /workspace/project-<slug>    # → variants/<name>.mp4 + sheet.jpg
```

Talk to the user in the language of their latest message. New voice lines and clips come from the
product's generation tools (follow their own cost and approval rules); publishing follows the
preview skill.

## What is worth varying

The first seconds decide whether an ad is watched, so hooks come first: change **one thing per
variant** or the result teaches nothing.

| axis     | what changes                                                 | cost                                              |
| -------- | ------------------------------------------------------------ | ------------------------------------------------- |
| hook     | the opening line (text + voice), optionally the opening shot | one TTS line; a new clip only if the shot changes |
| headline | wording of on-screen text anywhere in the ad                 | free                                              |
| size     | the canvas; pictures are cropped to fill                     | free (render time)                                |

Hook angles that differ in kind, not in wording: the problem, the result, a number, a question, a
contrarian claim, "watch this" (start on the demo). Write 3–5, each speakable in under 3 s. Keep
every claim to what the base ad already states or the user confirms: a variant is still their ad.

## Stages

1. **Base.** A project with `timeline.json` (from `product-video`, `viral-remake`,
   `short-drama-episode`), or `wrap` a finished MP4. Watch the base once and note where its hook
   ends (`hook_seconds`; default is the end of the first shot).
2. **Plan** `variants.json`: hooks, headlines, sizes. Show the user the matrix as a short table
   (name, what differs) with the count and the extra cost, and let them cut it. Default cap 12; list
   only the combinations worth testing in `combos` rather than the full product.
3. **Make the new pieces.** One text-to-speech call per new hook line in the base ad's voice
   (`assets/hook_<id>.mp3`); trim its edge silence; transcribe it once (`media-edit transcribe`) and
   read the text back. A new opening clip only when the angle needs a different picture.
4. **Build.** `variants.py build` prints every variant's length and warns when a size crops away
   more than 40% of the pictures.
5. **Render.** `variants.py render` runs one render at a time, normalises loudness (-14 LUFS) and
   writes `variants/manifest.json` and `variants/sheet.jpg` (every hook at 0.8 s, labelled). Look at
   the sheet: text inside the frame, the subject not cropped out, each hook visibly different.
6. **Deliver.** `media-preview variants/sheet.jpg "<变体一览>"`, then each MP4 with a title that
   says what differs ("钩子 2 · 4:5"), not the file name. Report the count, sizes, cost, and which
   variants you would test first and why.

## variants.json

| field          | meaning                                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prefix`       | start of every file name (`<prefix>_<hook>_<headline>_<size>.mp4`)                                                                                                                                            |
| `hook_seconds` | where the base hook ends; everything before it is replaced by a new hook                                                                                                                                      |
| `hooks[]`      | `{id}` alone keeps the base hook. Otherwise any of `text` (on-screen hook), `vo` (voice file), `line` (caption for that voice), `src` (new opening clip or image), `duration` (default: voice length + 0.3 s) |
| `headlines[]`  | `{id}` alone keeps the wording. `replace: {"old": "new"}` rewrites on-screen texts containing `old`; an `old` that is not on screen stops the build                                                           |
| `sizes`        | any of `9:16`, `4:5`, `1:1`, `16:9`                                                                                                                                                                           |
| `sources`      | per size, replacement files for shots that crop badly: `{"16:9": {"assets/s02.mp4": "assets/s02_wide.mp4"}}`                                                                                                  |
| `combos`       | exact list of `[hook, headline, size]` instead of the full matrix                                                                                                                                             |
| `limit`        | most variants allowed (12)                                                                                                                                                                                    |

A new hook shifts everything after it by the change in length: shots, texts, captions and voice
lines move together; music that runs under the whole ad stays where it is.

## Sizes

- 9:16 → 4:5 and 1:1 lose the top and bottom: usually fine when the subject is centred; captions and
  hook text are re-laid inside the new frame automatically.
- 9:16 ↔ 16:9 keeps about a third of the picture. Do not ship a blind crop: for footage of a person
  use `media-edit reframe` to make a followed crop and list it under `sources`; for generated shots
  regenerate the key shots in the target shape; otherwise leave that size out and say so.
- Each platform hides part of the frame behind its own buttons: keep must-read text out of the top
  10% and bottom 20% of a vertical ad.

## A finished MP4 (wrap)

`wrap` makes a one-shot project that plays the file with its own sound. You can put a new hook in
front (a clip, a voice line, hook text) replacing the first `hook_seconds`, and change the size.
Text burned into the picture cannot be reworded. Give a new hook its own opening clip (`src`): with
only a new voice line, the old opening keeps playing with its own sound underneath. Say this instead
of promising a clean swap.

## Gotchas

| symptom                                     | cause                                                | fix                                                              |
| ------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| `no on-screen text contains …`              | the headline lives in the picture or in captions     | reword in the source project; captions follow the voice          |
| the new hook's voice overlaps the next line | `hook_seconds` set before the old hook's voice ended | set it to the end of the first voiced shot                       |
| a hook clip freezes                         | clip shorter than the voice line                     | give `duration`, or a clip at least as long as the voice + 0.3 s |
| subject cut off in 1:1 / 16:9               | centre crop                                          | `sources` for that size, or drop the size                        |
| 20 near-identical files                     | full matrix                                          | `combos`: one change per variant                                 |
