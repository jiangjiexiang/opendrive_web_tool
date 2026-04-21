#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -d "node_modules" ]; then
  echo "[dev] node_modules 不存在，先安装依赖..."
  npm install
fi

if [ ! -x "native/bin/odr_json_parser" ]; then
  echo "[dev] 未检测到 native/bin/odr_json_parser，开始编译 native..."
  npm run build:native
fi

echo "[dev] 启动后端: http://localhost:5174"
npm run dev:server >/tmp/opendrive_backend.log 2>&1 &
BACKEND_PID=$!

cleanup() {
  echo
  echo "[dev] 正在关闭服务..."
  if kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    kill "$BACKEND_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

echo "[dev] 启动前端: http://localhost:5173"
echo "[dev] 后端日志: /tmp/opendrive_backend.log"
npm run dev
