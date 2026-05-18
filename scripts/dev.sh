#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

kill_port() {
  local port="$1"
  local pids=""
  if has_cmd lsof; then
    pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
  elif has_cmd fuser; then
    pids="$(fuser "$port"/tcp 2>/dev/null || true)"
  fi

  if [ -n "${pids// /}" ]; then
    echo "[dev] 检测到端口 $port 被占用，正在结束进程: $pids"
    kill $pids >/dev/null 2>&1 || true
    sleep 1
    kill -9 $pids >/dev/null 2>&1 || true
  fi
}

if ! has_cmd node; then
  echo "[dev] 缺少 node，请先安装 Node.js（建议 18+），或运行: bash scripts/first-run-dev.sh"
  exit 1
fi

if ! has_cmd npm; then
  echo "[dev] 缺少 npm，请先安装 npm，或运行: bash scripts/first-run-dev.sh"
  exit 1
fi

if [ ! -x "node_modules/.bin/vite" ]; then
  echo "[dev] 未检测到 node_modules/.bin/vite，正在安装/修复前端依赖..."
  if [ -d "node_modules" ]; then
    chmod -R u+rwX node_modules >/dev/null 2>&1 || true
    chmod +x node_modules/.bin/* node_modules/esbuild/bin/esbuild node_modules/@esbuild/*/bin/esbuild >/dev/null 2>&1 || true
  fi
  if ! npm install; then
    echo "[dev] npm install 失败，尝试清理 esbuild 后重装..."
    rm -rf node_modules/esbuild node_modules/@esbuild
    npm install
  fi
fi

if [ ! -x "native/bin/odr_json_parser" ]; then
  echo "[dev] 未检测到 native/bin/odr_json_parser，开始编译 native..."
  npm run build:native
fi

kill_port 5174
kill_port 5175

echo "[dev] 启动后端: http://localhost:5175"
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

echo "[dev] 启动前端: http://localhost:5174"
echo "[dev] 后端日志: /tmp/opendrive_backend.log"
npm run dev
