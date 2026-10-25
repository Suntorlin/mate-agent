#!/usr/bin/env bash
# Builds and runs the demo product (packages/demo-app) on 127.0.0.1:9320 against the local
# engine at WORKER_URL (foreground). The engine must name it as its product in .env.local:
# APP_MCP_URL, APP_TOKEN_URL and APP_ENGINE_TOKEN (see packages/demo-app/README.md).
set -euo pipefail
source "$(dirname "$0")/load-env.sh"
# The product never sees the model key; only the engine uses it.
unset OPENROUTER_API_KEY
export DEMO_ENGINE_URL="${DEMO_ENGINE_URL:-$WORKER_URL}"
cd "$ROOT"
cd packages/demo-app
npx vite build --logLevel warn
exec node server/main.ts
