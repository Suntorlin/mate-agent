#!/usr/bin/env bash
# HyperFrames (HeyGen, Apache-2.0) CLI behind the faceless-explainer skill and the HyperFrames
# skills it reads (hyperframes*, media-use under skills/builtin).
# Pinned version, its headless Chrome fetched at build time, telemetry off.
set -euo pipefail
source "$OI_INSTALL_DIR/common.sh"
export PATH="/opt/openinspect/node/bin:$PATH"
HYPERFRAMES_VERSION=0.8.140
npm install -g --no-audit --no-fund "hyperframes@$HYPERFRAMES_VERSION"
rm -rf /root/.npm/_cacache
export HYPERFRAMES_NO_TELEMETRY=1
hyperframes telemetry disable || true
hyperframes browser ensure
hyperframes --version
ln -sf "$(command -v hyperframes)" /usr/local/bin/hyperframes
