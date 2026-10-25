#!/usr/bin/env bash
# Screenshot a local HTML page (storyboard, shot list) with agent-browser, bounded in time.
#
#   screenshot_page.sh storyboard.html renders/storyboard.png [width] [height]
#
# Chrome's own `--headless --screenshot` mode never finishes in the sandbox (it hangs on the zygote
# and network service until killed), so this drives the preinstalled agent-browser instead: set the
# viewport (width x height), open the page, capture the full page. Each step runs under a hard
# `timeout` (SCREENSHOT_TIMEOUT_SECONDS, default 60) in a throwaway browser session that is always
# closed afterwards. Exits 124 when a step had to be killed.
set -euo pipefail
page="${1:?usage: screenshot_page.sh <page.html> <out.png> [width] [height]}"
out="${2:?usage: screenshot_page.sh <page.html> <out.png> [width] [height]}"
width="${3:-1240}"
height="${4:-900}"
timeout_seconds="${SCREENSHOT_TIMEOUT_SECONDS:-60}"

command -v agent-browser >/dev/null || { echo "agent-browser is not installed" >&2; exit 127; }
case "$page" in
  http://* | https://* | file://*) url="$page" ;;
  *) url="file://$(cd "$(dirname "$page")" && pwd)/$(basename "$page")" ;;
esac
mkdir -p "$(dirname "$out")"
out_abs="$(cd "$(dirname "$out")" && pwd)/$(basename "$out")"
rm -f "$out_abs"
session="screenshot-$$-$RANDOM"
trap 'timeout -k 5 15 agent-browser --session "$session" close >/dev/null 2>&1 || true' EXIT

step() {
  local status=0
  timeout -k 5 "$timeout_seconds" agent-browser --session "$session" "$@" >/dev/null 2>&1 || status=$?
  if [[ $status -eq 124 || $status -eq 137 ]]; then
    echo "agent-browser did not finish '$1' within ${timeout_seconds}s and was killed; simplify the page" >&2
    exit 124
  fi
  return "$status"
}
step set viewport "$width" "$height" || true
step open "$url" || { echo "agent-browser could not open $url" >&2; exit 1; }
step screenshot --full "$out_abs" || true
[[ -s "$out_abs" ]] || { echo "agent-browser exited without writing $out" >&2; exit 1; }
echo "$out"
