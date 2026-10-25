#!/usr/bin/env bash
# Runs scripts/local/agent-cli.mjs with .env.local loaded. The shared package's built output uses
# extensionless imports, so the CLI is bundled first (as the compose smoke bundles its driver).
set -euo pipefail
source "$(dirname "$0")/load-env.sh"
cd "$ROOT"
npx --no-install esbuild scripts/local/agent-cli.mjs --bundle --platform=node --format=esm \
  --target=node24 --external:ws --log-level=warning --outfile=.local/agent-cli.bundle.mjs
exec node .local/agent-cli.bundle.mjs "$@"
