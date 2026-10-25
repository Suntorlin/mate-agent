#!/usr/bin/env bash
# Runs the whole local stack in the background, or reports on / stops it.
#
#   scripts/local/stack.sh up       # object store, gateway, data plane, control plane, Demo Studio
#   scripts/local/stack.sh status
#   scripts/local/stack.sh logs [service]
#   scripts/local/stack.sh down
#
# Each service is the foreground script of the same name, started detached: its pid is in
# .local/run/<service>.pid and its output in .local/logs/<service>.log. `up` returns once every
# service answers on its port, or fails (and says which one) after STACK_START_TIMEOUT_SECONDS.
# Needs .env.local (scripts/local/env.sh) and the sandbox image (see the README).
set -euo pipefail
source "$(dirname "$0")/load-env.sh"

RUN_DIR="$ROOT/.local/run"
LOG_DIR="$ROOT/.local/logs"
STACK_START_TIMEOUT_SECONDS="${STACK_START_TIMEOUT_SECONDS:-180}"
SANDBOX_IMAGE="${DATAPLANE_IMAGE:-agent-engine-sandbox:local}"
# Start order is dependency order; `down` stops in the reverse.
SERVICES=(gateway dataplane control-plane demo-app)

url_of() {
  case "$1" in
    gateway) echo "http://127.0.0.1:${GATEWAY_PORT:-8795}/healthz" ;;
    dataplane) echo "http://127.0.0.1:${DATAPLANE_PORT:-9910}/healthz" ;;
    control-plane) echo "http://127.0.0.1:${PORT:-8797}/healthz" ;;
    demo-app) echo "http://127.0.0.1:${DEMO_PORT:-9320}/api/me" ;; # 401 signed out: it is up
  esac
}

pid_of() { cat "$RUN_DIR/$1.pid" 2>/dev/null || true; }
alive() { local pid; pid="$(pid_of "$1")"; [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; }
answers() { curl -s -o /dev/null --max-time 2 "$(url_of "$1")"; }

port_in_use() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

start() {
  local name="$1" port
  if alive "$name"; then echo "$name: already running (pid $(pid_of "$name"))"; return; fi
  port="$(url_of "$name" | sed -E 's|.*:([0-9]+)/.*|\1|')"
  if port_in_use "$port"; then
    echo "$name: port $port is held by something else; pick other ports (see scripts/local/env.sh)" >&2
    exit 1
  fi
  nohup "$ROOT/scripts/local/$name.sh" >"$LOG_DIR/$name.log" 2>&1 &
  echo $! >"$RUN_DIR/$name.pid"
  local waited=0
  until answers "$name"; do
    if ! alive "$name"; then
      echo "$name: exited while starting; last lines of $LOG_DIR/$name.log:" >&2
      tail -n 15 "$LOG_DIR/$name.log" >&2
      exit 1
    fi
    if ((waited >= STACK_START_TIMEOUT_SECONDS)); then
      echo "$name: no answer on $(url_of "$name") after ${STACK_START_TIMEOUT_SECONDS}s" >&2
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "$name: up (pid $(pid_of "$name"), ${waited}s)"
}

stop() {
  local name="$1" pid
  pid="$(pid_of "$name")"
  if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then rm -f "$RUN_DIR/$name.pid"; return; fi
  kill "$pid"
  for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid"
  rm -f "$RUN_DIR/$name.pid"
  echo "$name: stopped"
}

case "${1:-}" in
  up)
    [[ -n "${OPENROUTER_API_KEY:-}" ]] || { echo "no OpenRouter key (keychain or OPENROUTER_API_KEY)" >&2; exit 1; }
    docker image inspect "$SANDBOX_IMAGE" >/dev/null 2>&1 || {
      echo "sandbox image $SANDBOX_IMAGE is missing; build it first (README, 'Run it on this machine')" >&2
      exit 1
    }
    mkdir -p "$RUN_DIR" "$LOG_DIR"
    "$ROOT/scripts/local/object-store.sh" >"$LOG_DIR/object-store.log" 2>&1 \
      && echo "object-store: up" || { tail -n 15 "$LOG_DIR/object-store.log" >&2; exit 1; }
    for name in "${SERVICES[@]}"; do start "$name"; done
    echo "Demo Studio: http://localhost:${DEMO_PORT:-9320}"
    ;;
  status)
    for name in "${SERVICES[@]}"; do
      if alive "$name" && answers "$name"; then echo "$name: up (pid $(pid_of "$name"))"
      elif alive "$name"; then echo "$name: running, not answering"
      else echo "$name: down"; fi
    done
    ;;
  logs)
    if [[ -n "${2:-}" ]]; then tail -n 100 "$LOG_DIR/$2.log"; else tail -n 20 "$LOG_DIR"/*.log; fi
    ;;
  down)
    for ((i = ${#SERVICES[@]} - 1; i >= 0; i--)); do stop "${SERVICES[$i]}"; done
    # The data plane labels each sandbox it starts with its own port.
    local_sandboxes="$(docker ps -aq --filter "label=agent-engine.dataplane=${DATAPLANE_PORT:-9910}")"
    if [[ -n "$local_sandboxes" ]]; then
      # shellcheck disable=SC2086
      docker rm --force $local_sandboxes >/dev/null && echo "sandboxes: removed"
    fi
    OBJECT_STORE_ROOT_PASSWORD="$AWS_SECRET_ACCESS_KEY" \
      docker compose -p agent-engine-local -f "$ROOT/deploy/compose/docker-compose.local.yml" stop >/dev/null 2>&1 \
      && echo "object-store: stopped" || echo "object-store: could not stop it" >&2
    ;;
  *)
    echo "usage: $0 up|status|logs [service]|down" >&2
    exit 2
    ;;
esac
