// Example chain: one pixel world (8-bit cave), one flat-vector world (now), and the end card.
// Replace these with the user's chain. One world = enter → one line → one action → leave.
(() => {
  const S = 8,
    FOOT = 112,
    W = 1920,
    H = 1080,
    GROUND = 880;
  const rect = (g, x, y, w, h, col) => {
    g.fillStyle = col;
    g.fillRect(x, y, w, h);
  };
  const walkFrame = (s, n = 2, fps = 8) => (s.walking ? Math.floor(s.t * fps) % n : 0);
  const { ss, clamp } = FILM;

  // ---------- 1986 · 8-bit cave (pixel world, 240×135 ×8) ----------
  const CAVE_W = 300,
    CAVE = 70,
    OX = 172;
  function rock(g, x0, y0, w, h, lx0) {
    g.save();
    g.beginPath();
    g.rect(x0 - lx0, y0, w, h);
    g.clip();
    for (let y = y0; y < y0 + h; y += 8)
      for (let x = x0 - (((x0 % 8) + 8) % 8); x < x0 + w; x += 8) {
        const off = (y / 8) % 2 ? 4 : 0,
          X = x - lx0;
        rect(g, X, y, 8, 8, "#c84c0c");
        rect(g, X + off, y + 7, 8, 1, "#881400");
        rect(g, X + ((off + 7) % 8), y, 1, 7, "#881400");
        rect(g, X + off + 1, y + 1, 2, 1, "#fc9838");
      }
    g.restore();
  }
  function tree(g, x, y) {
    rect(g, x + 2, y, 12, 14, "#00a800");
    rect(g, x, y + 3, 16, 8, "#00a800");
    rect(g, x + 4, y + 2, 3, 3, "#80d010");
    rect(g, x + 6, y + 14, 4, 4, "#c84c0c");
  }
  FILM.add({
    id: "cave",
    label: { year: 1986, name: "8-BIT" },
    w: CAVE_W * S,
    stop: 1060,
    camAt: 340,
    v: 1000,
    seam: "#80d010",
    // w ≥ max(camAt, stop − 720) + 1980 keeps the next world out of frame while anyone talks
    script: [
      { line: "sage", pre: 0 },
      { beat: "take", dur: 0.9 },
    ],
    pixel: {
      S,
      draw(g, lx0, s) {
        rect(g, 0, 0, 260, 135, "#fcd8a8");
        for (let x = -10; x < CAVE; x += 20) tree(g, x - lx0, 30 + (x % 40 ? 10 : 0));
        rock(g, CAVE, 0, 300, 16, lx0);
        rock(g, CAVE - 10, 0, 12, 135, lx0);
        rect(g, CAVE + 2 - lx0, 16, 300, 135, "#000");
        rect(g, CAVE - 8 - lx0, 70, 10, 42, "#000");
        const f8 = Math.floor(s.t * 8);
        drawSpr(g, SPR.fire, f8, OX - 30 - lx0, FOOT - 16);
        drawSpr(g, SPR.oldman, 0, OX - lx0, FOOT - 16);
        drawSpr(g, SPR.fire, f8 + 1, OX + 30 - lx0, FOOT - 16);
        const tk = FILM.cue("take");
        if (!tk || s.t < tk.T) drawSpr(g, SPR.sword, 0, OX - 12 - lx0, FOOT - 13);
      },
    },
    ui(u, s) {
      // dialogue box: shown only during the stop (the engine enforces it)
      const q = FILM.cue("sage");
      if (!q || s.t < q.T - 0.2) return;
      const a = LINES.sage.box[0],
        b = LINES.sage.box[1],
        n = FILM.typed(s, "sage", a + b);
      FILM.ptext(u, a, 240, 60, n, "#fcfcfc", "center");
      FILM.ptext(u, b, 240, 82, n - [...a].length, "#fcfcfc", "center");
    },
    hero(s) {
      const tk = FILM.cue("take"),
        up = tk && s.t >= tk.T && s.t < tk.T + tk.dur;
      return { spr: SPR.kid, frame: up ? 0 : walkFrame(s), y: FOOT - (up ? 2 : 0) };
    },
  });

  // ---------- 2026 · flat vector (full-res world) ----------
  const U01 = (i) => {
    const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  function hdHero(c, x, foot, k, st) {
    // the same hero, first time with a real face
    c.save();
    c.translate(x, foot);
    c.scale(k, k);
    const ph = st.walk == null ? 0 : Math.sin(st.walk),
      bob = st.walk == null ? Math.sin(st.t * 2) * 1.5 : Math.abs(Math.cos(st.walk)) * 5;
    c.translate(0, -bob);
    const leg = (sd, col) => {
      c.save();
      c.translate(sd * 14, -150);
      c.rotate(-ph * sd * 0.35);
      c.fillStyle = col;
      c.beginPath();
      c.roundRect(-15, 0, 30, 140, 14);
      c.fill();
      c.fillStyle = "#2b2d42";
      c.beginPath();
      c.roundRect(-18, 128, 46, 22, 10);
      c.fill();
      c.restore();
    };
    leg(-1, "#3d405b");
    leg(1, "#4a4e6d");
    c.fillStyle = "#2a9d8f";
    c.beginPath();
    c.roundRect(-58, -330, 116, 196, 40);
    c.fill();
    const arm = (sd) => {
      c.save();
      c.translate(sd * 52, -310);
      c.rotate(sd * (0.12 + (st.walk == null ? 0.04 * Math.sin(st.t * 2) : -ph * 0.4 * sd)));
      c.fillStyle = "#2a9d8f";
      c.beginPath();
      c.roundRect(-16, 0, 32, 150, 16);
      c.fill();
      c.fillStyle = "#f2c4a0";
      c.beginPath();
      c.arc(0, 152, 16, 0, 7);
      c.fill();
      c.restore();
    };
    arm(-1);
    arm(1);
    c.fillStyle = "#e63946";
    c.beginPath();
    c.roundRect(-52, -350, 104, 36, 18);
    c.fill();
    c.save();
    c.translate(36, -330);
    c.rotate(0.3 + 0.1 * Math.sin(st.t * 5));
    c.beginPath();
    c.roundRect(0, 0, 26, 92, 10);
    c.fill();
    c.restore();
    c.fillStyle = "#f2c4a0";
    c.beginPath();
    c.ellipse(0, -430, 66, 74, 0, 0, 7);
    c.fill();
    c.fillStyle = "#1d1d2b";
    c.beginPath();
    [
      [-70, -440],
      [-88, -500],
      [-50, -488],
      [-48, -540],
      [-10, -506],
      [10, -556],
      [26, -504],
      [62, -530],
      [56, -484],
      [88, -480],
      [66, -440],
      [44, -470],
      [-40, -472],
    ].forEach(([a, b], i) => (i ? c.lineTo(a, b) : c.moveTo(a, b)));
    c.closePath();
    c.fill();
    const blink = st.t % 3.1 < 0.12 ? 0.15 : 1;
    c.beginPath();
    c.ellipse(-24, -428, 8, 11 * blink, 0, 0, 7);
    c.ellipse(24, -428, 8, 11 * blink, 0, 0, 7);
    c.fill();
    const m = st.mouth || 0;
    c.fillStyle = "#7a2e2e";
    c.beginPath();
    c.ellipse(0, -392, 14, 2 + 12 * m, 0, 0, 7);
    c.fill();
    c.restore();
  }
  const _sc = {};
  function sprCanvas(k) {
    if (_sc[k]) return _sc[k];
    const cv = document.createElement("canvas");
    cv.width = 16;
    cv.height = 16;
    drawSpr(cv.getContext("2d"), SPR[k], 0, 0, 0);
    return (_sc[k] = cv);
  }
  FILM.add({
    id: "now",
    label: { year: 2026, name: "NOW" },
    w: 2300,
    stop: 900,
    camAt: 0,
    v: 700,
    vOut: 1700,
    seam: "#ffffff",
    script: [
      { beat: "morph", dur: 1.6 },
      { line: "hero", pre: 0.6, post: 0.8 },
    ],
    tailHold: 0.4,
    draw(c, s) {
      const g = c.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, "#a8c8ff");
      g.addColorStop(0.6, "#ffd6b0");
      g.addColorStop(1, "#ffe8d0");
      c.fillStyle = g;
      c.fillRect(0, 0, W, H);
      const sx = 1300 - s.camX * 0.1;
      c.fillStyle = "#fff3d6";
      c.beginPath();
      c.arc(sx, 360, 150, 0, 7);
      c.fill();
      const layer = (par, col, seed, base, hmax) => {
        const off = -s.camX * par;
        c.fillStyle = col;
        for (let i = -2; i < 26; i++) {
          const x = off + i * 150,
            h = 120 + U01(i + seed) * hmax;
          c.fillRect(x, base - h, 120, h + 400);
        }
      };
      layer(0.2, "#c9b8e8", 1, 700, 260);
      layer(0.45, "#9d8ec9", 7, 760, 200);
      layer(0.7, "#6d5fa6", 13, 820, 140);
      c.fillStyle = "#f4ece1";
      c.fillRect(0, GROUND, W, H - GROUND);
      const hxS = s.hx - s.camX,
        m = FILM.cue("morph");
      if (m && s.t < m.T + m.dur * 0.6) {
        c.imageSmoothingEnabled = false;
        c.drawImage(sprCanvas("kid"), hxS - 128, GROUND - 256, 256, 256);
        if (m && s.t >= m.T)
          for (let r = 0; r < 3; r++) {
            const u = (s.t - m.T) / m.dur,
              rr = ((u * 3 + r / 3) % 1) * 600;
            c.strokeStyle = `rgba(255,255,255,${0.6 * (1 - rr / 600)})`;
            c.lineWidth = 8;
            c.beginPath();
            c.arc(hxS, GROUND - 260, rr, 0, 7);
            c.stroke();
          }
        return;
      }
      let mouth = 0;
      const q = FILM.cue("hero");
      if (q && s.t >= q.T && s.t < q.T + q.dur) mouth = 0.5 + 0.5 * Math.sin((s.t - q.T) * 44);
      hdHero(c, hxS, GROUND, 1.25, { t: s.t, walk: s.walking ? s.t * 8 : null, mouth });
      if (m && s.t >= m.T + m.dur * 0.6 && s.t < m.T + m.dur) {
        c.fillStyle = `rgba(255,255,255,${clamp(1 - (s.t - m.T - m.dur * 0.6) / (m.dur * 0.4))})`;
        c.fillRect(0, 0, W, H);
      }
    },
    over(c, s) {
      // the spoken line, large, while the hero speaks
      const q = FILM.cue("hero");
      if (!q || s.t < q.T || s.t > q.T + q.dur + 0.5) return;
      c.save();
      c.globalAlpha = clamp((s.t - q.T) / 0.25) * clamp((q.T + q.dur + 0.5 - s.t) / 0.25);
      c.textAlign = "center";
      c.font = "700 64px " + FILM.FONT.ui;
      c.fillStyle = "#2b2d42";
      c.fillText(LINES.hero.ja, 960, 200);
      c.restore();
    },
  });

  // ---------- End card ----------
  FILM.add({
    id: "end",
    w: 2100,
    stop: 60,
    camAt: 100,
    v: 1500,
    seam: "#ffffff",
    script: [
      { beat: "continue", dur: 3.0 },
      { line: "tag", pre: 0.3, post: 0.2 },
    ],
    tailHold: 1.4,
    draw(c) {
      c.fillStyle = "#000";
      c.fillRect(0, 0, W, H);
    },
    over(c, s) {
      const k = FILM.cue("continue");
      if (!k || s.t < k.T - 0.1) return;
      c.save();
      c.textAlign = "center";
      c.fillStyle = "#fcfcfc";
      if (s.t < k.T + k.dur) {
        const n = 3 - Math.floor((s.t - k.T) / 0.95);
        c.font = "72px " + FILM.FONT.arcade;
        c.fillText("CONTINUE?", 960, 470);
        if (n > 0) {
          c.font = "120px " + FILM.FONT.arcade;
          c.fillText(String(n), 960, 660);
        }
      } else {
        c.globalAlpha = clamp((s.t - k.T - k.dur) / 0.4);
        c.font = "800 120px " + FILM.FONT.ui;
        c.fillText(LINES.tag.title, 960, 500);
        c.font = "500 56px " + FILM.FONT.ui;
        c.fillStyle = "#9bd1ff";
        c.fillText(LINES.tag.ja, 960, 620);
      }
      c.restore();
    },
  });
})();
