# Sourced by the other scripts: exports every key of .env.local without echoing values.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ -f "$ROOT/.env.local" ]] || { echo "run scripts/local/env.sh first" >&2; exit 1; }
set -a
# shellcheck disable=SC1091
source "$ROOT/.env.local"
set +a
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"

# The model key stays in the macOS keychain: read it at start, never write it to a file.
if [[ -z "${OPENROUTER_API_KEY:-}" && -n "${OPENROUTER_KEYCHAIN_SERVICE:-}" ]]; then
  OPENROUTER_API_KEY="$(security find-generic-password -s "$OPENROUTER_KEYCHAIN_SERVICE" -w 2>/dev/null || true)"
  export OPENROUTER_API_KEY
fi
