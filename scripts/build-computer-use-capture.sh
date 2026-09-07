#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$ROOT_DIR/computer-use-capture/main.swift"
OUT_DIR="${1:-$ROOT_DIR/computer-use-capture}"
OUT="$OUT_DIR/computer-use-capture"
TARGET="${MACOS_DEPLOYMENT_TARGET:-13.0}"

mkdir -p "$OUT_DIR"
swiftc -O -target "arm64-apple-macos${TARGET}" -emit-executable "$SRC" -o "$OUT"
