#!/usr/bin/env node
// Render a long-scroll film project with the sandbox's headless Chrome (the one Remotion ships).
//
//   node render.mjs <project> --stills 1,5,9            → <project>/out/stills/tNNN.NN.png
//   node render.mjs <project> --video out/film.mp4      → silent H.264, 30 fps (mux audio after mix.py)
//   options: --from S --to S --fps N
//
// Every run writes <project>/out/timeline.json (absolute cue times, used by mix.py). Line durations
// come from <project>/audio/voice/<id>.(wav|mp3) when present, otherwise from the text length.
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const args = process.argv.slice(2);
const root = path.resolve(args[0] || ".");
const opt = (k, d) => {
  const i = args.indexOf("--" + k);
  return i > 0 ? args[i + 1] : d;
};
const starter = process.env.REMOTION_STARTER || "/opt/media/remotion-starter";
const req = createRequire(path.join(starter, "package.json"));
const puppeteer = req("puppeteer-core");

// The image pre-downloads Remotion's headless shell under the starter (`remotion browser ensure`);
// find it there so a session never downloads Chrome (sessions may be offline).
function findShell(dir, depth = 0) {
  if (!fs.existsSync(dir) || depth > 4) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === "chrome-headless-shell") return p;
    if (e.isDirectory()) {
      const f = findShell(p, depth + 1);
      if (f) return f;
    }
  }
  return null;
}
async function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const local = findShell(path.join(starter, "node_modules/.remotion"));
  if (local) return local;
  process.chdir(starter);
  const st = await req("@remotion/renderer").ensureBrowser();
  if (st && st.path) return st.path;
  throw new Error("No headless Chrome: set CHROME_PATH");
}

const voice = {};
const vdir = path.join(root, "audio/voice");
if (fs.existsSync(vdir))
  for (const f of fs.readdirSync(vdir)) {
    const m = f.match(/^(.+)\.(wav|mp3|m4a)$/);
    if (!m) continue;
    voice[m[1]] = parseFloat(
      execFileSync("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        path.join(vdir, f),
      ]).toString()
    );
  }

const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".json": "application/json",
};
const srv = http.createServer((q, r) => {
  const p = path.join(root, decodeURIComponent(q.url.split("?")[0]));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    r.writeHead(404);
    return r.end();
  }
  r.writeHead(200, { "content-type": types[path.extname(p)] || "application/octet-stream" });
  fs.createReadStream(p).pipe(r);
});
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
const browser = await puppeteer.launch({
  executablePath: await chromePath(),
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  const pg = await browser.newPage();
  await pg.setViewport({ width: 1920, height: 1080 });
  pg.on("pageerror", (e) => console.error("[page error]", e.message));
  await pg.evaluateOnNewDocument((v) => {
    window.VOICE = v;
  }, voice);
  await pg.goto(`http://127.0.0.1:${srv.address().port}/film/index.html`);
  const info = await pg.evaluate("window.ready");
  fs.mkdirSync(path.join(root, "out"), { recursive: true });
  fs.writeFileSync(path.join(root, "out/timeline.json"), JSON.stringify(info, null, 1));
  console.log(
    `total ${info.total.toFixed(2)}s  ` +
      info.segs.map((s) => `${s.id}@${s.tIn.toFixed(1)}`).join(" ")
  );
  const grab = async (t) => Buffer.from(await pg.evaluate((x) => window.grab(x), t), "base64");
  const stills = opt("stills");
  if (stills) {
    const od = path.join(root, "out/stills");
    fs.mkdirSync(od, { recursive: true });
    for (const t of stills.split(",").map(Number))
      fs.writeFileSync(path.join(od, `t${t.toFixed(2).padStart(6, "0")}.png`), await grab(t));
    console.log("stills ->", od);
  }
  const video = opt("video");
  if (video) {
    const fps = +opt("fps", 30),
      t0 = +opt("from", 0),
      t1 = +opt("to", 0) || info.total,
      n = Math.round((t1 - t0) * fps);
    const out = path.resolve(root, video);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const ff = spawn(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-f",
        "image2pipe",
        "-r",
        String(fps),
        "-i",
        "-",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-crf",
        "17",
        out,
      ],
      { stdio: ["pipe", "inherit", "inherit"] }
    );
    for (let i = 0; i < n; i++) {
      if (!ff.stdin.write(await grab(t0 + i / fps)))
        await new Promise((ok) => ff.stdin.once("drain", ok));
      if (i % 150 === 0) console.log(`${i}/${n}`);
    }
    ff.stdin.end();
    await new Promise((ok) => ff.on("close", ok));
    console.log("video ->", out);
  }
} finally {
  await browser.close();
  srv.close();
}
