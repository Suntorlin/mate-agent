#!/usr/bin/env bash
# Generate the offline test media referenced by sample-timeline.json (ffmpeg only).
#   make-sample-assets.sh <dir>   # writes <dir>/assets/* next to a copy of the sample timeline
set -euo pipefail
dir="${1:?usage: make-sample-assets.sh <dir>}"
here="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
mkdir -p "$dir/assets"
cp "$here/sample-timeline.json" "$dir/timeline.json"
cd "$dir/assets"
ffmpeg -hide_banner -loglevel error -y -f lavfi \
  -i "gradients=s=1080x1920:c0=0xff4e50:c1=0xf9d423:x0=0:y0=0:x1=1080:y1=1920:d=1" \
  -frames:v 1 gradient.png
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "color=c=0x0f172a:s=1080x1920:d=1" \
  -vf "drawgrid=w=120:h=120:t=4:c=0x38bdf8@0.7" -frames:v 1 grid.png
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc2=s=1080x1920:r=30:d=4" \
  -c:v libx264 -pix_fmt yuv420p clip.mp4
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=440:sample_rate=48000:d=10" \
  -c:a aac -b:a 128k tone.m4a
ls -l
