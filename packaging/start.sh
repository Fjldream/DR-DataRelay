#!/usr/bin/env sh
set -eu
BASE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ulimit -n 65535 2>/dev/null || true
export PM2_HOME="$BASE_DIR/data/pm2"
export DATA_RELAY_NODE="$BASE_DIR/runtime/bin/node"
export PATH="$BASE_DIR/runtime/bin:$PATH"
mkdir -p "$BASE_DIR/data/pm2" "$BASE_DIR/logs"
"$DATA_RELAY_NODE" "$BASE_DIR/node_modules/pm2/bin/pm2" start "$BASE_DIR/ecosystem.config.cjs" --update-env
"$DATA_RELAY_NODE" "$BASE_DIR/node_modules/pm2/bin/pm2" save
