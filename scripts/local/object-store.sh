#!/usr/bin/env bash
# Starts the local S3-compatible store (SeaweedFS) on 127.0.0.1:9017.
set -euo pipefail
source "$(dirname "$0")/load-env.sh"
OBJECT_STORE_ROOT_PASSWORD="$AWS_SECRET_ACCESS_KEY" \
  docker compose -p agent-engine-local -f "$ROOT/deploy/compose/docker-compose.local.yml" up -d --wait
