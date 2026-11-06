#!/usr/bin/env sh
set -eu
BASE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export PM2_HOME="$BASE_DIR/data/pm2"
export DATA_RELAY_NODE="$BASE_DIR/runtime/bin/node"
"$DATA_RELAY_NODE" "$BASE_DIR/node_modules/pm2/bin/pm2" restart data-relay --update-env
