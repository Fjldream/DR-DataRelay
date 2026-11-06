#!/usr/bin/env sh
set -eu
BASE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export PM2_HOME="$BASE_DIR/data/pm2"
"$BASE_DIR/runtime/bin/node" "$BASE_DIR/node_modules/pm2/bin/pm2" logs data-relay --lines 200
