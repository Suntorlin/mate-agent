#!/usr/bin/env bash
set -euo pipefail
source /etc/os-release
case "$ID" in debian|ubuntu) ;; *) echo "Unsupported Debian target: $ID" >&2; exit 1 ;; esac
export DEBIAN_FRONTEND=noninteractive
install -d -m 1777 /tmp
apt-get update
# Ubuntu 24.04+ renamed several libraries with a t64 suffix; take whichever name the release has.
pick() { for p in "$@"; do apt-cache show "$p" >/dev/null 2>&1 && { echo "$p"; return; }; done; echo "No package among: $*" >&2; return 1; }
# Plain assignments, so set -e stops the build when a library is missing.
atk="$(pick libatk1.0-0t64 libatk1.0-0)"
atk_bridge="$(pick libatk-bridge2.0-0t64 libatk-bridge2.0-0)"
cups="$(pick libcups2t64 libcups2)"
audio_library="$(pick libasound2t64 libasound2)"
apt-get install -y --no-install-recommends git curl build-essential ca-certificates gnupg openssh-client jq unzip \
  passwd adduser sysvinit-utils procps util-linux xz-utils ffmpeg xvfb fluxbox x11vnc \
  websockify novnc libnss3 libnspr4 "$atk" "$atk_bridge" "$cups" libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 "$audio_library" \
  libpango-1.0-0 libcairo2
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg
printf '%s\n' 'deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main' > /etc/apt/sources.list.d/github-cli.list
apt-get update
apt-get install -y --no-install-recommends gh
