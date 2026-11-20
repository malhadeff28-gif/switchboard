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
# Source checkouts keep their existing local workspace; the packaged launcher
# otherwise defaults to the operating system's application-data directory.
export SWITCHBOARD_DATA_DIR="${SWITCHBOARD_DATA_DIR:-$PWD/.local}"
exec "$switchboard_node" scripts/launch.mjs
