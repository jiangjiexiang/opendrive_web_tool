#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

BUILD_DIR="native/build"
SOURCE_DIR="$(cd native && pwd)"
CACHE_FILE="$BUILD_DIR/CMakeCache.txt"

reset_build_dir=false

if [ -f "$CACHE_FILE" ]; then
  cache_source="$(sed -n 's#^CMAKE_HOME_DIRECTORY:INTERNAL=##p' "$CACHE_FILE" | head -n 1)"
  cache_build="$(sed -n 's#^CMAKE_CACHEFILE_DIR:INTERNAL=##p' "$CACHE_FILE" | head -n 1)"
  expected_build="$(cd "$(dirname "$CACHE_FILE")" && pwd)"

  if [ -n "$cache_source" ] && [ "$cache_source" != "$SOURCE_DIR" ]; then
    echo "[build:native] 检测到失效的 CMake 源目录缓存: $cache_source"
    reset_build_dir=true
  elif [ -n "$cache_build" ] && [ "$cache_build" != "$expected_build" ]; then
    echo "[build:native] 检测到失效的 CMake 构建目录缓存: $cache_build"
    reset_build_dir=true
  fi
fi

if [ "$reset_build_dir" = true ]; then
  echo "[build:native] 清理 $BUILD_DIR 并重新生成构建文件..."
  rm -rf "$BUILD_DIR"
fi

cmake -S native -B "$BUILD_DIR"
cmake --build "$BUILD_DIR" --target odr_json_parser -j 4
