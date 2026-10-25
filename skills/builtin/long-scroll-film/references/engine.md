# Long-scroll engine

Engine: `template/film/engine.js` (timeline, camera, borders, captions, pixel text; copied by
`new_film.sh`) and `scripts/render.mjs` (stills, full render, `out/timeline.json`). Write the worlds
in `film/worlds.js` (each calls `FILM.add({...})`), lines in `film/lines.js`
(`window.LINES = { id: { ja, zh, who } }`).

## Segment interface

```js
FILM.add({
  id, label: { year, name }, w, stop, camAt,     // width, where the hero stops, camera left edge at the stop (segment px)
  v, vOut,                                       // walking speed in / out (px/s); default FILM.V
  script: [{ line: 'king', pre: 0, post: 0.2 }, { beat: 'choose', dur: 1.0 }],
  pixel: { S: 8, draw(g, lx0, s) },              // low-res world; lx0 = canvas left edge in low px
  hero(s) -> { spr, frame, y, h, pal },           // pixel hero, feet at y
  draw(c, s),                                    // or a full-res world
  front(g, lx0, s),                              // pixel layer above the hero (followers)
  ui(u, s), over(c, s),                          // 480×270 pixel UI / full-res overlay, stop window only
  seam: '#hex',                                  // border colour of the world being entered
});
```

`s = { t, lt, at, camX, hx, walking, act, lines, seg }`. Time every event from `FILM.cue(id).T`,
never from "seconds after entering"; then speed and line-length changes never break choreography.

## Timeline

- Durations: `audio/voice/<id>.(wav|mp3)` measured by `render.mjs` and injected as `window.VOICE`;
  silent lines carry a fixed `dur`; beats carry their own `dur`.
- Camera: walk target `hero − 720`; at a stop eases to `camAt` over 0.7 s; monotone (never back);
  Gaussian smoothing (σ ≈ 4 frames).
- Borders: a pixel staircase (54 px steps, ±28 px) clipped per world; the hero is drawn in both
  worlds and clipped, so it restyles as it crosses.
- The last world ends when its stop ends (no walk-out).

## Audio

`scripts/mix.py` + `audio/score.json`: per-world loop sequenced from note strings, written only
inside the world's time window with 0.25 s fades; SFX and jingles placed on cue times; typing blips
one per character over 65 % of the line; voices normalised; music ducked to 40 % under voice;
`loudnorm I=-14 TP=-1.5`.

## Cost and speed (measured)

1920×1080, 30 fps: about 8–10 frames/s on a laptop; the mix takes seconds.
