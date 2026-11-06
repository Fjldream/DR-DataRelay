#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
DEFAULT_AUTHORITY=$(CDPATH= cd -- "$PROJECT_ROOT/.." && pwd)/DataMigration-LicenseAuthority

export LICENSE_TOOL_HOME="${LICENSE_TOOL_HOME:-$DEFAULT_AUTHORITY}"
export LICENSE_TOOL_KEYS_DIR="${LICENSE_TOOL_KEYS_DIR:-$LICENSE_TOOL_HOME}"
exec node "$SCRIPT_DIR/license-tool-server.mjs"
