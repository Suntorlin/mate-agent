#!/usr/bin/env bash
# Scaffold a long-scroll film project from the skill template.
#   new_film.sh /workspace/project-<slug>
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="${1:?usage: new_film.sh <project dir>}"
mkdir -p "$dest/film/fonts" "$dest/audio/voice" "$dest/out"
cp -n "$here"/template/film/*.js "$here"/template/film/index.html "$dest/film/"
cp -n "$here/template/audio/score.json" "$dest/audio/" 2>/dev/null || true
# Optional pixel fonts (OFL). Skipped silently offline; the engine falls back to Noto CJK.
for f in "DotGothic16/DotGothic16-Regular.ttf" "PressStart2P/PressStart2P-Regular.ttf"; do
  name="$(basename "$f")"; dir="$(dirname "$f" | tr '[:upper:]' '[:lower:]')"
  [[ -f "$dest/film/fonts/$name" ]] || curl -fsSL -m 20 -o "$dest/film/fonts/$name" \
    "https://github.com/google/fonts/raw/main/ofl/$dir/$name" 2>/dev/null || rm -f "$dest/film/fonts/$name"
done
echo "project: $dest"
echo "next: edit film/lines.js and film/worlds.js, then: node $here/scripts/render.mjs $dest --stills 2,6"
