#!/usr/bin/env bash
# Builds and runs the control plane's Node host on 127.0.0.1:8797 (foreground).
set -euo pipefail
source "$(dirname "$0")/load-env.sh"
mkdir -p "$DATA_DIR"
# The inline runtime and Jev use the same OpenRouter key unless .env.local names others.
export INLINE_LLM_API_KEY="${INLINE_LLM_API_KEY:-${OPENROUTER_API_KEY:-}}"
export JEV_API_KEY="${JEV_API_KEY:-${OPENROUTER_API_KEY:-}}"
cd "$ROOT"
npm run build -w @open-inspect/shared >/dev/null
npm run build:node -w @open-inspect/control-plane >/dev/null
exec node packages/control-plane/dist/node/main.js
