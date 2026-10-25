#!/usr/bin/env bash
# One-time Vercel base for the comparison: the media toolchain install/media.sh puts on the E2B
# (Debian) image, installed on Vercel's Ubuntu-based node:24 managed image. Runs as root.
#   setup-vercel.sh <runtime-user>    (expects the starter tarball at /tmp/starter.tgz)
set -euo pipefail
owner="${1:?usage: setup-vercel.sh <runtime-user>}"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
# Ubuntu 24.04+ renamed several Chrome libraries with a t64 suffix; take whichever exists.
pick() { for p in "$@"; do apt-cache show "$p" >/dev/null 2>&1 && { echo "$p"; return; }; done; echo "no package: $*" >&2; exit 1; }
apt-get install -y -q --no-install-recommends ffmpeg fontconfig fonts-noto-cjk fonts-noto-color-emoji \
  libnss3 libdbus-1-3 libgbm1 libxrandr2 libxkbcommon0 libxfixes3 libxcomposite1 libxdamage1 \
  libpango-1.0-0 libcairo2 "$(pick libasound2t64 libasound2)" "$(pick libatk1.0-0t64 libatk1.0-0)" \
  "$(pick libcups2t64 libcups2)" "$(pick libatk-bridge2.0-0t64 libatk-bridge2.0-0)"
fc-cache -f
starter=/opt/media/remotion-starter
rm -rf "$starter" && mkdir -p "$starter"
tar -xzf /tmp/starter.tgz -C "$starter"
(cd "$starter" && npm ci --ignore-scripts --no-audit --no-fund && npx --no-install remotion browser ensure)
chown -R "$owner" "$starter"
ln -sf "$starter/render.sh" /usr/local/bin/render
