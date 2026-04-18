#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VTS_RUNTIME_DIR="${VTS_RUNTIME_DIR:-$ROOT_DIR/../vts_map_interface/build_unix/runtime}"
DST_DIR="$ROOT_DIR/native/bin"

mkdir -p "$DST_DIR"

copy_if_exists() {
  local src="$1"
  local dst="$2"
  if [ -f "$src" ]; then
    cp "$src" "$dst"
    chmod +x "$dst"
    echo "[sync] copied $(basename "$src") -> $(basename "$dst")"
  else
    echo "[sync] missing: $src"
  fi
}

copy_if_exists "$VTS_RUNTIME_DIR/VTSMapCheckApp" "$DST_DIR/check_map"
copy_if_exists "$VTS_RUNTIME_DIR/VTSMapRouteApp" "$DST_DIR/route_test"

