// 长卷引擎：N 个游戏世界首尾相接，主角从左走到右；到每段的 stop 处停下演一场（时长由台词音频决定），再继续走。
// 段接口：
//   FILM.add({ id, label: {year, name}, w, stop, camAt,          // 段宽、停步点、停步时镜头左缘（段内坐标，屏幕像素）
//     pixel: { S, draw(g, lx0, s) },                            // 像素世界：在低分辨率画布上画，lx0 = 画布左缘的段内低像素坐标
//     hero(s) -> { spr, frame, flip, y }                         // 像素主角（脚底 y 为低像素）
//     draw(c, s),                                               // 或：全分辨率世界（3D/高清段）
//     ui(u, s),                                                 // 屏幕固定 UI，画在 480×270 半像素层（1 像素 = 4 屏幕像素）
//     over(c, s),                                               // 全分辨率覆盖层（屏幕坐标）
//     script: [ {line: 'id', at: 秒} | {wait: 秒} ... ],        // 停步时演的戏；at 相对停步开始
//     seam: '#fff' })                                           // 进入本段的边界颜色
// s = { t, lt, at, camX(段内), hx(段内主角 x), walking, act(bool), lines(当前台词) }
(() => {
  const W = 1920,
    H = 1080,
    FPS = 30;
  const F = (window.FILM = { segs: [], V: 860, START: 260, TAIL: 0 });
  // Font stacks: project fonts in film/fonts/ load first (index.html); the sandbox's Noto CJK is the fallback.
  F.FONT = {
    pixel: '"DotGothic16","Noto Sans CJK JP","Noto Sans JP",sans-serif',
    arcade: '"PressStart2P","DotGothic16","Noto Sans Mono CJK JP",monospace',
    caption: '"Noto Sans CJK SC","Noto Sans SC","PingFang SC",sans-serif',
    ui: '"Noto Sans CJK JP","Noto Sans JP",sans-serif',
  };
  F.add = (s) => F.segs.push(s);
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const ss = (x) => {
    x = clamp(x);
    return x * x * (3 - 2 * x);
  };
  F.ss = ss;
  F.clamp = clamp;

  // 台词时长：window.VOICE = { id: 秒 }（render.py 从 audio/voice/*.wav 量出来注入）；没有就按字数估
  F.dur = (id) => {
    const L = window.LINES[id] || {};
    return L.dur || (window.VOICE && window.VOICE[id]) || 0.6 + 0.13 * (L.ja || "").length;
  };

  F.layout = () => {
    let x = 0,
      t = 0;
    const plan = [];
    F.cues = [];
    F.segs.forEach((s, k) => {
      s.x0 = x;
      s.x1 = x + s.w;
      // 戏：把 script 展开成绝对时间
      let at = 0;
      const cues = [];
      for (const q of s.script || []) {
        if (q.wait) {
          at += q.wait;
          continue;
        }
        if (q.line) {
          const st = at + (q.pre ?? 0.1),
            d = F.dur(q.line);
          cues.push({ line: q.line, at: st, dur: d });
          at = st + d + (q.post ?? 0.2);
        }
        if (q.beat) {
          cues.push({ beat: q.beat, at, dur: q.dur || 0 });
          at += q.dur || 0;
        }
      }
      s.actDur = s.script ? at + (s.tailHold ?? 0.12) : 0;
      const lx = k === 0 ? F.START : 0;
      s.tIn = t;
      if (s.script) {
        const V = s.v || F.V,
          tw1 = (s.stop - lx) / V;
        s.actT = t + tw1;
        plan.push({ s, kind: "walk", t0: t, t1: s.actT, x0: x + lx, x1: x + s.stop });
        plan.push({
          s,
          kind: "act",
          t0: s.actT,
          t1: s.actT + s.actDur,
          x0: x + s.stop,
          x1: x + s.stop,
        });
        t = s.actT + s.actDur;
        cues.forEach((c) => F.cues.push({ ...c, seg: s.id, T: s.actT + c.at }));
        if (k < F.segs.length - 1) {
          const tw2 = (s.w - s.stop) / (s.vOut || V);
          plan.push({ s, kind: "walk", t0: t, t1: t + tw2, x0: x + s.stop, x1: x + s.w });
          t += tw2;
        } // 最后一段演完即收
      } else {
        const tw = (s.w - lx) / (s.v || F.V);
        plan.push({ s, kind: "walk", t0: t, t1: t + tw, x0: x + lx, x1: x + s.w });
        t += tw;
      }
      s.tOut = t;
      s.cues = cues;
      x += s.w;
    });
    F.plan = plan;
    F.total = t + F.TAIL;
    // 镜头：原始目标（走路时主角在 720；停步时 camAt）→ 单调不退 → 高斯平滑；预先按帧算好
    const n = Math.ceil(F.total * FPS) + 1,
      raw = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const tt = i / FPS,
        h = F.heroAt(tt);
      let v = h.x - 720;
      if (h.p.kind === "act" && h.p.s.camAt != null) {
        const u = ss((tt - h.p.t0) / 0.7);
        v = h.x - 720 + (h.p.s.x0 + h.p.s.camAt - (h.x - 720)) * u;
      }
      raw[i] = Math.max(0, i ? Math.max(raw[i - 1], v) : v);
    }
    const R = 9,
      cam = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let a = 0,
        wsum = 0;
      for (let j = -R; j <= R; j++) {
        const k = clamp(i + j, 0, n - 1),
          w = Math.exp(-(j * j) / (2 * 16));
        a += raw[k] * w;
        wsum += w;
      }
      cam[i] = a / wsum;
    }
    F.cam = cam;
    return F;
  };
  F.heroAt = (t) => {
    const p = F.plan.find((q) => t >= q.t0 && t < q.t1) || F.plan[F.plan.length - 1];
    const u = clamp((t - p.t0) / Math.max(1e-6, p.t1 - p.t0));
    return { x: p.x0 + (p.x1 - p.x0) * u, p, walking: p.kind === "walk" && t < p.t1 };
  };
  F.camAt = (t) => {
    const i = clamp(t * FPS, 0, F.cam.length - 1),
      a = Math.floor(i),
      b = Math.min(a + 1, F.cam.length - 1);
    return F.cam[a] + (F.cam[b] - F.cam[a]) * (i - a);
  };

  // 边界：像素阶梯（每 48px 一级，三级循环），游戏感
  F.seamX = (s, y) => s.x0 + 28 * ((Math.floor(y / 54) % 3) - 1);
  function band(c, a, b, camX) {
    c.beginPath();
    for (let y = 0; y <= H; y += 54) {
      const x = a ? F.seamX(a, y) - camX : -80;
      c.lineTo(x, y);
      c.lineTo(x, y + 54);
    }
    for (let y = H; y >= 0; y -= 54) {
      const x = b ? F.seamX(b, y) - camX : W + 80;
      c.lineTo(x, y + 54);
      c.lineTo(x, y);
    }
    c.closePath();
    c.clip();
  }

  const lowCache = {};
  function low(S) {
    const k = S;
    if (!lowCache[k]) {
      const cv = document.createElement("canvas");
      cv.width = Math.ceil(W / S) + 2;
      cv.height = Math.ceil(H / S);
      lowCache[k] = cv;
    }
    return lowCache[k];
  }
  const ui = document.createElement("canvas");
  ui.width = 480;
  ui.height = 270;
  const ug = ui.getContext("2d");

  F.ctxFor = (s, t, hero, camX) => {
    const act = hero.p.s === s && hero.p.kind === "act";
    const lines = F.cues.filter(
      (q) => q.seg === s.id && q.line && t >= q.T && t < q.T + q.dur + 0.6
    );
    return {
      t,
      lt: t - s.tIn,
      at: s.actT != null ? t - s.actT : -1,
      camX: camX - s.x0,
      hx: hero.x - s.x0,
      walking: hero.walking && hero.p.s === s,
      act,
      lines,
      seg: s,
    };
  };

  F.draw = (c, t) => {
    if (!F.plan) F.layout();
    const hero = F.heroAt(t),
      camX = F.camAt(t);
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = "#000";
    c.fillRect(0, 0, W, H);
    const vis = F.segs.filter((s) => s.x1 + 80 > camX && s.x0 - 80 < camX + W);
    for (const s of vis) {
      const k = F.segs.indexOf(s),
        nx = F.segs[k + 1],
        S = F.ctxFor(s, t, hero, camX);
      c.save();
      band(c, k ? s : null, nx, camX);
      if (s.pixel) {
        const P = s.pixel,
          cv = low(P.S),
          g = cv.getContext("2d"),
          lx0 = Math.floor(S.camX / P.S);
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, cv.width, cv.height);
        g.imageSmoothingEnabled = false;
        P.draw(g, lx0, S);
        if (s.hero) {
          const h = s.hero(S);
          if (h) {
            const hx = Math.round(S.hx / P.S) - lx0;
            drawSpr(
              g,
              h.spr,
              h.frame || 0,
              hx - Math.floor((h.w || 16) / 2),
              h.y - (h.h || 16),
              h.flip,
              h.pal
            );
          }
        }
        if (P.front) P.front(g, lx0, S);
        if (s.front) s.front(g, lx0, S);
        c.imageSmoothingEnabled = false;
        c.drawImage(cv, -(S.camX - lx0 * P.S), 0, cv.width * P.S, cv.height * P.S);
      } else if (s.draw) s.draw(c, S);
      c.restore();
    }
    // 边界线（属于进入的段）
    for (const s of vis) {
      const k = F.segs.indexOf(s);
      if (!k) continue;
      c.save();
      c.fillStyle = s.seam || "#fcfcfc";
      for (let y = 0; y < H; y += 54) {
        const x = F.seamX(s, y) - camX;
        c.fillRect(x - 4, y, 8, 54);
        c.fillRect(
          Math.min(x, F.seamX(s, y + 54) - camX) - 4,
          y + 50,
          Math.abs(F.seamX(s, y + 54) - F.seamX(s, y)) + 8,
          8
        );
      }
      c.restore();
    }
    // 当前段（主角所在段）的屏幕 UI 与覆盖层
    const cur = hero.p.s,
      S = F.ctxFor(cur, t, hero, camX);
    const inAct = cur.actT != null && t >= cur.actT - 0.4 && t < cur.actT + cur.actDur + 0.25; // 对白框只在这一场戏里出现，走开就收
    if (inAct && cur.ui) {
      ug.setTransform(1, 0, 0, 1, 0, 0);
      ug.clearRect(0, 0, 480, 270);
      cur.ui(ug, S);
      c.imageSmoothingEnabled = false;
      c.drawImage(ui, 0, 0, W, H);
    }
    if (inAct && cur.over) cur.over(c, S);
    F.label(c, cur, t);
    F.subtitle(c, t);
  };

  // 角标：年份 + 游戏名（切段时淡入）
  F.label = (c, s, t) => {
    if (!s.label) return;
    const a = ss((t - s.tIn - 0.15) / 0.35);
    c.save();
    c.globalAlpha = a;
    c.fillStyle = "rgba(0,0,0,0.78)";
    c.fillRect(1440, 28, 452, 104);
    c.textAlign = "right";
    c.fillStyle = "#fcfcfc";
    c.font = "34px " + F.FONT.arcade;
    c.fillText(String(s.label.year), 1868, 74);
    c.font = "32px " + F.FONT.pixel;
    c.fillText(s.label.name, 1868, 116);
    c.restore();
  };
  // 中文字幕：台词播放时显示
  F.subtitle = (c, t) => {
    let txt = null;
    const q = F.cues.find((q) => q.line && t >= q.T && t < q.T + q.dur + 0.4);
    if (q) txt = (window.LINES[q.line] || {}).zh;
    else {
      const b = F.cues.find(
        (q) => q.beat && window.BEATSUB && window.BEATSUB[q.beat] && t >= q.T && t < q.T + 1.6
      );
      if (b) txt = window.BEATSUB[b.beat];
    }
    if (!txt) return;
    const L = { zh: txt };
    c.save();
    c.textAlign = "center";
    c.font = "800 44px " + F.FONT.caption;
    c.lineJoin = "round";
    c.lineWidth = 10;
    c.strokeStyle = "#000";
    c.fillStyle = "#fff";
    c.strokeText(L.zh, 960, 1046);
    c.fillText(L.zh, 960, 1046);
    c.restore();
  };

  // 像素字（UI 层，480×270）：DotGothic16 16px，阈值去抗锯齿；n = 显示字数
  const tcv = document.createElement("canvas");
  tcv.width = 480;
  tcv.height = 22;
  const tg = tcv.getContext("2d");
  F.ptext = (u, str, x, y, n = 1e9, col = "#fcfcfc", align = "left") => {
    tg.clearRect(0, 0, 480, 22);
    tg.font = "16px " + F.FONT.pixel;
    tg.textBaseline = "top";
    tg.fillStyle = col;
    const w = tg.measureText(str).width,
      x0 = align === "center" ? Math.round(240 - w / 2) : 0;
    tg.fillText([...str].slice(0, Math.max(0, n)).join(""), x0, 2);
    const im = tg.getImageData(0, 0, 480, 22),
      d = im.data;
    for (let i = 3; i < d.length; i += 4) d[i] = d[i] > 110 ? 255 : 0;
    tg.putImageData(im, 0, 0);
    u.drawImage(tcv, align === "center" ? x - 240 : x, y);
    return w;
  };
  // 打字机：本台词开始后按台词时长匀速打完（留 15% 余量）
  F.typed = (s, id, str) => {
    const q = F.cues.find((q) => q.line === id);
    if (!q) return 0;
    const u = (s.t - q.T) / Math.max(0.25, q.dur * 0.65);
    return u < 0 ? 0 : Math.floor(clamp(u) * [...str].length + (u >= 1 ? 99 : 0));
  };
  F.cue = (id) => F.cues.find((q) => q.line === id || q.beat === id);
})();
