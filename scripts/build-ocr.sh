#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT_DIR="${1:-$ROOT/electron/accessibility}"
TARGET="${MACOSX_DEPLOYMENT_TARGET:-13.0}"
mkdir -p "$OUTPUT_DIR"
swiftc -O -target "arm64-apple-macos${TARGET}" -framework Vision -framework AppKit \
  "$ROOT/electron/accessibility/ocr.swift" -o "$OUTPUT_DIR/ocr"
