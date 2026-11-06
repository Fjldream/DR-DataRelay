#!/usr/bin/env sh
set -eu
BASE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SCRIPT="$BASE_DIR/tools/tcp-batch-simulator.js"
if [ ! -f "$SCRIPT" ]; then SCRIPT="$BASE_DIR/tools/tcp-batch-simulator.cjs"; fi
exec "$BASE_DIR/runtime/bin/node" "$SCRIPT" "$@"
