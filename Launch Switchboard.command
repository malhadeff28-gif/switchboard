#!/bin/zsh
set -eu
cd -- "$(dirname -- "$0")"
switchboard_node="${SWITCHBOARD_NODE:-}"
if [[ -z "$switchboard_node" ]]; then
  switchboard_node="$(command -v node || true)"
fi
if [[ -z "$switchboard_node" ]]; then
  switchboard_node="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
fi
if [[ ! -x "$switchboard_node" ]]; then
  print 'Node.js 20 or later is needed to launch Switchboard.'
  exit 1
fi
switchboard_url="http://127.0.0.1:${PORT:-4317}"
if curl --silent --fail "$switchboard_url/api/bootstrap" >/dev/null; then
  open "$switchboard_url"
  exit 0
fi
"$switchboard_node" server.mjs &
switchboard_pid=$!
trap 'kill "$switchboard_pid" 2>/dev/null || true' EXIT INT TERM
for switchboard_attempt in {1..40}; do
  if curl --silent --fail "$switchboard_url/api/bootstrap" >/dev/null; then
    open "$switchboard_url"
    break
  fi
  sleep 0.25
done
print 'Keep this window open while using Switchboard. Press Ctrl+C to stop.'
wait "$switchboard_pid"
