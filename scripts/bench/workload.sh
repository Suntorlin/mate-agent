#!/usr/bin/env bash
# The render step of a media project, identical on every provider: build a 64 s 9:16 timeline
# from the starter's sample assets, render it with render (all cores), then run the loudness QA
# pass. Prints one JSON line. cpu_busy_s is VM CPU time from /proc/stat, which is what active-CPU
# billing (Vercel) charges for.
set -euo pipefail
export PATH="/opt/openinspect/node/bin:$PATH"
starter=/opt/media/remotion-starter
work="$(mktemp -d)"
busy() { awk '/^cpu /{printf "%.2f", ($2+$3+$4+$7+$8)/100}' /proc/stat; }
now() { date +%s.%N; }

cpu0=$(busy); t0=$(now)
bash "$starter/examples/make-sample-assets.sh" "$work" >/dev/null
node -e '
  const fs = require("fs"), f = process.argv[1], t = JSON.parse(fs.readFileSync(f));
  const block = t.shots.reduce((s, x) => s + x.duration, 0), n = 8, shift = (o, d) => ({ ...o, start: o.start + d });
  const rep = (xs, fn) => Array.from({ length: n }, (_, i) => xs.map((x) => fn(x, i * block))).flat();
  t.shots = rep(t.shots, (x) => x);
  t.texts = rep(t.texts, shift);
  t.captions = rep(t.captions, (c, d) => ({ ...c, words: c.words.map((w) => ({ ...w, start: w.start + d, end: w.end + d })) }));
  t.audio = rep(t.audio, shift);
  fs.writeFileSync(f, JSON.stringify(t));
' "$work/timeline.json"
t1=$(now)
render "$work/timeline.json" "$work/out.mp4" >"$work/render.log" 2>&1 || { tail -30 "$work/render.log" >&2; exit 1; }
t2=$(now)
ffmpeg -hide_banner -nostats -i "$work/out.mp4" -af loudnorm=print_format=json -f null - 2>"$work/qa.log"
t3=$(now); cpu1=$(busy)

video_s=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$work/out.mp4")
model=$(awk -F': ' '/^model name/{print $2; exit}' /proc/cpuinfo)
mem_mb=$(awk '/^MemTotal/{printf "%d", $2/1024}' /proc/meminfo)
awk -v m="$model" -v n="$(nproc)" -v mem="$mem_mb" -v t0="$t0" -v t1="$t1" -v t2="$t2" -v t3="$t3" \
  -v c0="$cpu0" -v c1="$cpu1" -v v="$video_s" 'BEGIN {
  printf "{\"cpu_model\":\"%s\",\"nproc\":%d,\"mem_mb\":%d,\"assets_s\":%.1f,\"render_s\":%.1f,", m, n, mem, t1 - t0, t2 - t1
  printf "\"qa_s\":%.1f,\"cpu_busy_s\":%.1f,\"video_s\":%.1f}\n", t3 - t2, c1 - c0, v
}'
