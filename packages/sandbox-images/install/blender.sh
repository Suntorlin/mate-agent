#!/usr/bin/env bash
# Headless Blender for the blender skill: 3D renders, procedural scenes and model format
# conversion via `blender -b`. Run by install/media.sh after the media phase (frame sequences are
# assembled with its ffmpeg); re-runnable on its own with `install.sh blender`. The sandbox
# has no GPU, so Cycles renders on CPU and EEVEE is not usable; the skill documents that boundary.
set -euo pipefail
source "$OI_INSTALL_DIR/common.sh"
BLENDER_VERSION=4.5.14
BLENDER_FILE="Blender4.5/blender-$BLENDER_VERSION-linux-x64.tar.xz"
# From https://download.blender.org/release/Blender4.5/blender-4.5.14.sha256
BLENDER_SHA256=9ba871ff2ecd36526b77432745980b7e6664ecd0c7ca11c48849073dcfe06da3
# download.blender.org returns 403 to datacenter egress (E2B/Vercel builders), so the official
# mirrors come first; the pinned digest makes the choice of mirror irrelevant to integrity.
BLENDER_MIRRORS=(
  "https://ftp.nluug.nl/pub/graphics/blender/release"
  "https://mirrors.ocf.berkeley.edu/blender/release"
  "https://download.blender.org/release"
)

case "$OI_OS" in
  debian)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    # The official build bundles its heavy libraries; these are the system pieces it still links
    # that the base and media phases do not already install.
    apt-get install -y --no-install-recommends libx11-6 libxi6 libxxf86vm1 libxrender1 libsm6 \
      libgl1 libegl1
    ;;
  *)
    echo "The blender toolchain supports Debian/Ubuntu images only (got $OI_OS)" >&2
    exit 1
    ;;
esac

downloaded=0
for mirror in "${BLENDER_MIRRORS[@]}"; do
  if download_checked "$mirror/$BLENDER_FILE" "$BLENDER_SHA256" /tmp/blender.tar.xz; then
    downloaded=1
    break
  fi
done
[[ "$downloaded" == 1 ]]
rm -rf /opt/blender
mkdir -p /opt/blender
tar -xJf /tmp/blender.tar.xz -C /opt/blender --strip-components=1
rm -f /tmp/blender.tar.xz
# The build runs as root; the runtime user on some substrates is not.
chmod -R a+rX /opt/blender
ln -sf /opt/blender/blender /usr/local/bin/blender

# Verify: the binary answers, bpy scripting works, and a real Cycles CPU render produces a frame.
blender --version | head -1
blender -b --factory-startup --python-expr \
  'import bpy; print("bpy ok", bpy.app.version_string)'
render_dir="$(mktemp -d)"
blender -b --factory-startup --python-expr \
  'import bpy; s = bpy.context.scene; s.cycles.samples = 8; s.render.resolution_x = 64; s.render.resolution_y = 64' \
  -E CYCLES -o "$render_dir/frame_####" -F PNG -f 1
[[ -s "$render_dir/frame_0001.png" ]]
rm -rf "$render_dir"
