#!/usr/bin/env bash
# Runs the local Docker data plane on 127.0.0.1:9910 (foreground). Sandboxes get the image's
# runtime environment. With GATEWAY_URL set they reach models through the gateway, with the token
# the control plane gives them; without it, straight through OpenRouter with the key.
set -euo pipefail
source "$(dirname "$0")/load-env.sh"
cd "$ROOT"
# DATAPLANE_PORT moves it, e.g. for a second checkout running beside the first.
export PORT="${DATAPLANE_PORT:-9910}"
export DATAPLANE_RUNTIME_ENV
DATAPLANE_RUNTIME_ENV="$(python3 packages/sandbox-images/cli.py plan --provider daytona |
  python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)[0]["runtimeEnv"]))')"
if [[ -z "${GATEWAY_URL:-}" ]]; then
  export ANTHROPIC_BASE_URL=https://openrouter.ai/api
  export ANTHROPIC_AUTH_TOKEN="${OPENROUTER_API_KEY:-}"
  # The runtime adopts the key family only when ANTHROPIC_API_KEY is set; OpenRouter reads the bearer.
  export ANTHROPIC_API_KEY="${OPENROUTER_API_KEY:-}"
  export DATAPLANE_SANDBOX_ENV=ANTHROPIC_BASE_URL,ANTHROPIC_AUTH_TOKEN,ANTHROPIC_API_KEY
fi
exec node packages/docker-dataplane/server.mjs
