#!/usr/bin/env bash
# Render a timeline.json to a 9:16 H.264 (yuv420p) + AAC MP4 with the preinstalled starter.
#
#   render.sh <timeline.json> <out.mp4>
#
# Local media paths in the timeline are relative to the timeline.json directory (or absolute).
# RENDER_CONCURRENCY overrides the parallel browser tabs (default 100% of available cores).
set -euo pipefail

if (( $# != 2 )); then
  echo "Usage: render.sh <timeline.json> <out.mp4>" >&2
  exit 64
fi
starter="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
timeline="$1"
mkdir -p "$(dirname "$2")"
out="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
stage="$(mktemp -d "${TMPDIR:-/tmp}/render.XXXXXX")"
trap 'rm -rf "$stage"' EXIT

node "$starter/scripts/prepare.mjs" "$timeline" "$stage"
concurrency="${RENDER_CONCURRENCY:-100%}"
cd "$starter"
npx --no-install remotion render src/index.ts Timeline "$out" \
  --props="$stage/props.json" \
  --public-dir="$stage/public" \
  --codec=h264 \
  --pixel-format=yuv420p \
  --color-space=bt709 \
  --audio-codec=aac \
  --concurrency="$concurrency" \
  --enable-multiprocess-on-linux
echo "rendered: $out"
