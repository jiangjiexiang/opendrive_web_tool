#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "[first-run] 准备首次启动环境..."

OS_NAME="$(uname -s || true)"

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

install_on_mac() {
  local pkg="$1"
  if ! has_cmd brew; then
    echo "[first-run] 缺少 Homebrew，无法自动安装 $pkg。"
    echo "[first-run] 请先安装 Homebrew: https://brew.sh"
    return 1
  fi
  echo "[first-run] 使用 brew 安装: $pkg"
  brew list "$pkg" >/dev/null 2>&1 || brew install "$pkg"
}

install_on_linux() {
  local pkg="$1"
  if ! has_cmd apt-get; then
    echo "[first-run] 未检测到 apt-get，当前 Linux 发行版暂不支持自动安装 $pkg。"
    return 1
  fi
  if has_cmd sudo; then
    echo "[first-run] 使用 apt-get 安装: $pkg"
    sudo apt-get update -y
    sudo apt-get install -y "$pkg"
  else
    echo "[first-run] 使用 apt-get 安装: $pkg"
    apt-get update -y
    apt-get install -y "$pkg"
  fi
}

ensure_cmd() {
  local cmd="$1"
  local mac_pkg="${2:-}"
  local linux_pkg="${3:-}"
  local hint="${4:-}"
  if has_cmd "$cmd"; then
    return 0
  fi

  echo "[first-run] 缺少命令: $cmd，尝试自动安装..."
  if [[ "$OS_NAME" == "Darwin" ]]; then
    if [[ -n "$mac_pkg" ]]; then
      install_on_mac "$mac_pkg" || true
    fi
  elif [[ "$OS_NAME" == "Linux" ]]; then
    if [[ -n "$linux_pkg" ]]; then
      install_on_linux "$linux_pkg" || true
    fi
  fi

  if ! has_cmd "$cmd"; then
    echo "[first-run] 自动安装失败或未生效: $cmd"
    if [[ -n "$hint" ]]; then
      echo "[first-run] $hint"
    fi
    exit 1
  fi
}

ensure_cmd node "node" "nodejs" "请先安装 Node.js（建议 18+）。"
ensure_cmd npm "node" "npm" "请先安装 npm。"
ensure_cmd cmake "cmake" "cmake" "请先安装 CMake（用于编译 native/odr_json_parser）。"
ensure_cmd make "" "build-essential" "请先安装 C/C++ 构建工具链（如 build-essential 或 Xcode CLT）。"

echo "[first-run] Node: $(node -v)"
echo "[first-run] npm:  $(npm -v)"
echo "[first-run] CMake: $(cmake --version | head -n 1)"

if [ ! -d "node_modules" ]; then
  echo "[first-run] 安装前端依赖..."
  npm install
else
  echo "[first-run] node_modules 已存在，跳过安装。"
fi

echo "[first-run] 编译 native 解析器（首次建议强制编译一次）..."
bash ./scripts/build-native.sh

echo "[first-run] 环境准备完成，启动开发服务..."
exec ./scripts/dev.sh
