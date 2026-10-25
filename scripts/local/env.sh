#!/usr/bin/env bash
# Creates .env.local (ignored by git) with fresh local secrets, once, and prints nothing secret.
# Every local process reads it: the control plane, the data plane, the CLI. The model key is
# not generated here: it is read from the keychain item OPENROUTER_KEYCHAIN_SERVICE names.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FILE="$ROOT/.env.local"
if [[ -f "$FILE" ]]; then echo ".env.local exists; leaving it as is"; exit 0; fi
# Ports are overridable when another stack already holds the defaults:
#   ENGINE_PORT=18797 GATEWAY_PORT=18795 scripts/local/env.sh
ENGINE_PORT="${ENGINE_PORT:-8797}"
GATEWAY_PORT="${GATEWAY_PORT:-8795}"
DATAPLANE_PORT="${DATAPLANE_PORT:-9910}"
LOCAL_OBJECT_STORE_PORT="${LOCAL_OBJECT_STORE_PORT:-9017}"
DEMO_PORT="${DEMO_PORT:-9320}"
b64() { openssl rand -base64 32; }
hex() { openssl rand -hex 32; }
umask 077
cat > "$FILE" <<CONF
# Local-only stack (scripts/local). Never commit; never copy into a cloud config.
DEPLOYMENT_NAME=local
APP_NAME="Mate Agent"
GITHUB_BOT_USERNAME=agent-engine[bot]
SCM_PROVIDER=github
LOG_LEVEL=info
HOST=127.0.0.1
PORT=$ENGINE_PORT
GATEWAY_PORT=$GATEWAY_PORT
DATAPLANE_PORT=$DATAPLANE_PORT
LOCAL_OBJECT_STORE_PORT=$LOCAL_OBJECT_STORE_PORT
DEMO_PORT=$DEMO_PORT
DATA_DIR=$ROOT/.local/data
MIGRATIONS_DIR=$ROOT/deploy/d1/migrations
WORKER_URL=http://localhost:$ENGINE_PORT
WEB_APP_URL=http://localhost:5173
DEFAULT_SESSION_VISIBILITY=private
TOKEN_ENCRYPTION_KEY=$(b64)
PROVIDER_ACCOUNTS_ENCRYPTION_KEY=$(b64)
REPO_SECRETS_ENCRYPTION_KEY=$(b64)
BROWSER_AUTH_SECRET=$(b64)
IMAGE_CALLBACK_TOKEN_PEPPER=$(hex)
SERVICE_AUTH_SECRET_SLACK_BOT=$(hex)
# Sandboxes: the local Docker data plane, spoken to as if it were Modal.
SANDBOX_PROVIDER=modal
MODAL_WORKSPACE=local
MODAL_API_URL=http://127.0.0.1:$DATAPLANE_PORT
MODAL_API_SECRET=$(hex)
# Object store: SeaweedFS from deploy/compose/docker-compose.local.yml.
OBJECT_STORE_BUCKET=media
OBJECT_STORE_REGION=us-east-1
OBJECT_STORE_ENDPOINT=http://127.0.0.1:$LOCAL_OBJECT_STORE_PORT
OBJECT_STORE_ALLOW_HTTP=true
OBJECT_STORE_FORCE_PATH_STYLE=true
AWS_ACCESS_KEY_ID=objectstoreadmin
AWS_SECRET_ACCESS_KEY=$(openssl rand -hex 16)
# The LLM gateway (scripts/local/gateway.sh): sandboxes get a per-session token for it and no
# model key; the gateway holds the OpenRouter key.
GATEWAY_URL=http://127.0.0.1:$GATEWAY_PORT
GATEWAY_SECRET=$(hex)
# The OpenRouter key is read from this keychain item at start (scripts/local/load-env.sh);
# OPENROUTER_API_KEY overrides it.
OPENROUTER_KEYCHAIN_SERVICE=claude-code-openrouter
OPENROUTER_API_KEY=
# Prompts that need no computer run inline (no sandbox); Jev decides per prompt.
INLINE_LLM_BASE_URL=https://openrouter.ai/api
INLINE_MODEL=anthropic/claude-sonnet-4.6
# The reference product (Demo Studio, scripts/local/demo-app.sh) as the engine's product: it signs
# with SERVICE_AUTH_SECRET_APP; the engine mints its MCP tokens through APP_TOKEN_URL.
SERVICE_AUTH_SECRET_APP=$(hex)
APP_ENGINE_TOKEN=$(hex)
APP_MCP_URL=http://localhost:$DEMO_PORT/api/mcp
APP_TOKEN_URL=http://localhost:$DEMO_PORT/api/engine/mcp-token
CONF
echo "wrote .env.local"
