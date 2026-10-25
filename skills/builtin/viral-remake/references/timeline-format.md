# timeline.json format

Rendered by `render timeline.json out.mp4` (`/opt/media/remotion-starter/render.sh`). The exact
schema, with every default, is `/opt/media/remotion-starter/src/schema.js`; a worked example is
`/opt/media/remotion-starter/examples/sample-timeline.json`. All times are seconds on the output
timeline. Local `src` paths are relative to the directory holding timeline.json (or absolute);
`http(s)://` URLs also work but need network during the render, so download media into `assets/`.

```json
{
  "canvas": { "width": 1080, "height": 1920, "fps": 30, "background": "#000000" },
  "shots": [
    {
      "src": "assets/s01.png",
      "duration": 1.6,
      "kenBurns": { "from": { "scale": 1.0 }, "to": { "scale": 1.12, "y": -2 } }
    },
    {
      "src": "assets/s02.mp4",
      "duration": 2.4,
      "trimStart": 0.3,
      "transition": { "type": "crossfade", "duration": 0.3 }
    }
  ],
  "texts": [
    {
      "text": "3 mistakes you're making",
      "start": 0,
      "duration": 1.6,
      "style": "hook",
      "position": "top"
    }
  ],
  "captions": [
    {
      "words": [
        { "text": "Most", "start": 1.6, "end": 1.9 },
        { "text": "people", "start": 1.9, "end": 2.3 }
      ],
      "style": "highlight",
      "position": "lower"
    }
  ],
  "audio": [
    { "src": "assets/vo.mp3", "start": 0, "volume": 1 },
    { "src": "assets/music.mp3", "start": 0, "volume": 0.2, "trimStart": 8 }
  ]
}
```

## canvas

`width` 1080, `height` 1920, `fps` 30 by default. Total length = the end of the last shot.

## shots (drawn in order, later on top)

| field        | default      | meaning                                                                                                                                                                           |
| ------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src`        | required     | image (png/jpg/webp/gif/avif) or video (mp4/mov/webm/m4v/mkv)                                                                                                                     |
| `type`       | by extension | `image` or `video`; needed for URLs without an extension                                                                                                                          |
| `start`      | previous end | seconds; gaps show `canvas.background`                                                                                                                                            |
| `duration`   | required     | seconds on screen (the cut point is `start + duration`)                                                                                                                           |
| `fit`        | `cover`      | `cover` fills and crops; `contain` letterboxes                                                                                                                                    |
| `kenBurns`   | none         | `{from, to}` each `{scale, x, y}`; x/y shift in % of the canvas                                                                                                                   |
| `trimStart`  | 0            | seconds skipped at the start of a video source                                                                                                                                    |
| `volume`     | 0 (muted)    | the video's own soundtrack; 0–2                                                                                                                                                   |
| `transition` | cut          | `{type: "crossfade", duration}`: this shot fades in over the previous one starting at its `start`; the previous shot stays underneath, so cut points and total length do not move |

Ken Burns: keep `scale >= 1 + |x|/50` and `>= 1 + |y|/50` or the canvas edge shows. A video shorter
than `trimStart + duration` holds its last frame; `render.sh` warns about it.

## texts

`text`, `start`, `duration` (required); `style` = `hook` (huge, outlined, pops in), `title`
(default), `caption`, `label` (dark text on a white box), `plain`; `position` = `top` | `upper` |
`center` (default) | `lower` | `bottom` or `{x, y}` fractions of the canvas (center of the block);
optional `fontSize` (px at 1080 wide), `color`, `strokeColor`, `background` (box color), `align`,
`maxWidth` (fraction, default 0.88), `animation` = `pop` | `fade` | `none`. Newlines in `text` are
kept. The anchors stay inside the Reels/TikTok safe area; avoid `{y}` above 0.1 or below 0.8.

## captions (word-by-word highlight)

`words`: `[{text, start, end}]` in time order (required). A word stays highlighted until the next
one starts. Optional `start`/`end` (line visibility, default first word start / last word end),
`style` = `highlight` (active word recolored, default yellow) | `box` (active word on a colored box,
default red), `position` (default `lower`), `fontSize` (default 64), `color`, `highlightColor`. Keep
one line to 2–6 words. Latin words get spaces between them; adjacent CJK words do not, so split
Chinese into words, not characters.

## audio

`src`, `start` (0), `volume` (1, range 0–2), `trimStart` (0), `duration` (default: to the end of the
source, cut at the end of the video).

## Fonts

Noto Sans CJK (SC/JP/KR, Latin included) and Noto Color Emoji are installed; mixed Chinese, English
and emoji render with one look. Other fonts are not available offline. Symbols outside these fonts,
such as ❚❚ (pause) or ⌕ (search), render as empty boxes: keep them out of `texts` and use an emoji
or an image shot instead (in a custom Remotion project, inline SVG).

## Validation

`render.sh` validates before rendering and prints every problem with its JSON path, e.g.
`timeline.shots[2].duration: Invalid input: expected number, received string`, then exits 2.
Warnings (render continues) flag media shorter than its slot.
