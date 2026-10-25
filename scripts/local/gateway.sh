#!/usr/bin/env bash
# Builds and runs the LLM gateway's Node host on 127.0.0.1:GATEWAY_PORT (8795 by default; foreground), its ledger under
# .local/gateway. Sandboxes reach their model only through it: the control plane hands each one a
# per-session token signed with GATEWAY_SECRET, and the gateway calls OpenRouter with the key.
set -euo pipefail
source "$(dirname "$0")/load-env.sh"
[[ -n "${GATEWAY_SECRET:-}" ]] || { echo "GATEWAY_SECRET is not set in .env.local" >&2; exit 1; }
[[ -n "${OPENROUTER_API_KEY:-}" ]] || { echo "no OpenRouter key (keychain or OPENROUTER_API_KEY)" >&2; exit 1; }
# .env.local's HOST, PORT and DATA_DIR are the control plane's.
export HOST=127.0.0.1 PORT="${GATEWAY_PORT:-8795}" DATA_DIR="$ROOT/.local/gateway"
mkdir -p "$DATA_DIR"
cd "$ROOT"
npm run build:node -w @open-inspect/gateway >/dev/null
exec node packages/gateway/dist/node/main.js
