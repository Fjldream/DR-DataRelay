#!/usr/bin/env sh
set -eu
BASE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export PM2_HOME="$BASE_DIR/data/pm2"
NODE="$BASE_DIR/runtime/bin/node"
PM2="$BASE_DIR/node_modules/pm2/bin/pm2"
"$NODE" "$PM2" delete data-relay 2>/dev/null || true
"$NODE" "$PM2" save --force 2>/dev/null || true
"$NODE" "$PM2" kill 2>/dev/null || true
echo "Data Relay 进程已移除，data 和 logs 目录未删除。"
