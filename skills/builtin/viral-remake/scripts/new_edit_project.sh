#!/usr/bin/env bash
# Create a custom Remotion edit project (motion-graphics kit) that reuses the preinstalled starter's
# node_modules, so it renders offline.
#
#   new_edit_project.sh /workspace/project/edit
#
# Then: put media under <dir>/public/{clips,assets,audio} (copies or hard links, not symlinks),
# edit src/Main.tsx (shot table, overlays, audio) and render:
#   cd <dir> && npx --no-install remotion render src/index.ts Main renders/v01.mp4 \
#     --codec=h264 --pixel-format=yuv420p --audio-codec=aac --enable-multiprocess-on-linux \
#     --concurrency=8
# (Remotion's default uses half the CPUs; at 8 a 56 s 1080x1920 cut renders in about 70 s.)
set -euo pipefail
dir="${1:?usage: new_edit_project.sh <dir>}"
kit="$(cd "$(dirname "$0")/../references/mg-kit" && pwd)"
starter="${REMOTION_STARTER:-/opt/media/remotion-starter}"
mkdir -p "$dir"/{public/clips,public/assets,public/audio,renders}
cp -R "$kit/src" "$dir/"
ln -sfn "$starter/node_modules" "$dir/node_modules"
cat > "$dir/package.json" <<'JSON'
{ "name": "motion-edit", "private": true, "type": "module" }
JSON
echo "edit project ready: $dir (render with npx --no-install remotion render src/index.ts Main renders/v01.mp4 --concurrency=8)"
