#!/usr/bin/env bash
# Optional media variant: ffmpeg, the Chrome libraries and fonts Remotion needs, and a
# preinstalled Remotion starter whose headless browser is downloaded now so renders need no
# network. Runs only while constructing the image candidate (install.sh media), never at session boot.
set -euo pipefail
source "$OI_INSTALL_DIR/common.sh"
# Amazon Linux 2023 (the Vercel substrate) packages no ffmpeg, so it gets this static build instead.
# There is no published checksum for it; the digest was recorded from the download on 2026-09-30.
FFMPEG_STATIC_URL=https://johnvansickle.com/ffmpeg/old-releases/ffmpeg-6.0.1-amd64-static.tar.xz
FFMPEG_STATIC_SHA256=28268bf402f1083833ea269331587f60a242848880073be8016501d864bd07a5
export PATH="/opt/openinspect/node/bin:$PATH"
starter=/opt/media/remotion-starter
case "$OI_OS" in
  debian)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    # The os/debian phase already installs ffmpeg and the Chrome libraries from
    # https://www.remotion.dev/docs/miscellaneous/linux-dependencies (including their t64 renames on
    # Ubuntu); this adds the one it lacks plus CJK and emoji fonts, and zstd, which the runtime's
    # workspace copies compress with (gzip is the slower fallback).
    apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-noto-cjk fonts-noto-color-emoji \
      libdbus-1-3 zstd
    ;;
  amazon-linux)
    # The os/amazon-linux phase already installs the Chrome libraries Remotion needs.
    dnf install -y fontconfig google-noto-sans-cjk-ttc-fonts google-noto-emoji-color-fonts zstd
    download_checked "$FFMPEG_STATIC_URL" "$FFMPEG_STATIC_SHA256" /tmp/ffmpeg-static.tar.xz
    tar -xJf /tmp/ffmpeg-static.tar.xz -C /tmp
    install -m 0755 /tmp/ffmpeg-*-amd64-static/ffmpeg /tmp/ffmpeg-*-amd64-static/ffprobe /usr/local/bin/
    rm -rf /tmp/ffmpeg-static.tar.xz /tmp/ffmpeg-*-amd64-static
    ;;
  *)
    echo "The media variant supports Debian and Amazon Linux (got $OI_OS)" >&2
    exit 1
    ;;
esac
fc-cache -f
rm -rf "$starter"
mkdir -p "$(dirname "$starter")"
cp -a "$OI_BUNDLE/skills/remotion-starter" "$starter"
(cd "$starter" && npm ci --ignore-scripts --no-audit --no-fund && npx --no-install remotion browser ensure)
rm -rf /root/.npm/_cacache
ln -sf "$starter/render.sh" /usr/local/bin/render
# The builtin skills join the runtime's bundled skills, which the Claude harness installs into every
# session; media-preview and media-export back the preview skill, and save-skill backs
# save-as-skill. The memory skill's `mem` comes with the runtime (sandbox_runtime/bin, put on PATH
# at session start, where the hooks claude_settings.py writes call it), so none is installed here.
for skill in "$OI_BUNDLE"/skills/builtin/*/; do
  cp -a "$skill" /app/sandbox_runtime/skills/
done
# viral-remake's make_music.py and qa.py import numpy and scipy; preinstall them so sessions do not.
/opt/openinspect/uv/uv pip install --python /opt/openinspect/python/bin/python --no-cache \
  numpy==2.5.3 scipy==1.18.1
install -m 0755 "$OI_BUNDLE/skills/builtin/preview/scripts/media-preview" /usr/local/bin/media-preview
install -m 0755 "$OI_BUNDLE/skills/builtin/save-as-skill/scripts/save-skill" /usr/local/bin/save-skill
install -m 0755 "$OI_BUNDLE/skills/builtin/preview/scripts/media-export" /usr/local/bin/media-export
# Renders write Remotion's bundle cache under the starter, so the runtime user must own it.
chown -R "$OI_RUNTIME_USER:$(id -gn "$OI_RUNTIME_USER")" "$starter"
encoders="$(ffmpeg -hide_banner -encoders)"
fonts="$(fc-list)"
[[ "$encoders" == *libx264* && "$fonts" == *'Noto Sans CJK'* && "$fonts" == *'Noto Color Emoji'* ]]
[[ -f /app/sandbox_runtime/skills/viral-remake/SKILL.md ]]
[[ -f /app/sandbox_runtime/bin/mem && -f /app/sandbox_runtime/bin/language-hook ]]
[[ -f /app/sandbox_runtime/skills/preview/SKILL.md && -x /usr/local/bin/media-preview ]]
[[ -f /app/sandbox_runtime/skills/save-as-skill/SKILL.md && -x /usr/local/bin/save-skill ]]
[[ -x /usr/local/bin/media-export ]]
/opt/openinspect/python/bin/python -c 'import numpy, scipy.signal, scipy.io.wavfile'
# The editing toolchain behind the media-edit skill (models, OCR, image tools, Python libraries).
bash "$OI_INSTALL_DIR/media-edit.sh"
# Headless Blender behind the blender skill (3D renders, model conversion).
bash "$OI_INSTALL_DIR/blender.sh"
[[ -f /app/sandbox_runtime/skills/blender/SKILL.md ]]
# The pinned HyperFrames CLI behind the faceless-explainer skill.
bash "$OI_INSTALL_DIR/hyperframes.sh"
[[ -f /app/sandbox_runtime/skills/faceless-explainer/SKILL.md && -x /usr/local/bin/hyperframes ]]
