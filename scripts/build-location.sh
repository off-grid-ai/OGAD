#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="${1:-$ROOT_DIR/resources/bin}"
NATIVE_ARCH="${OFFGRID_NATIVE_ARCH:-$(node -p 'process.arch')}"
case "$NATIVE_ARCH" in
  arm64) TARGET="arm64-apple-macos13.0" ;;
  x86_64) TARGET="x86_64-apple-macos13.0" ;;
  *) echo "unsupported macOS architecture: $NATIVE_ARCH" >&2; exit 1 ;;
esac

mkdir -p "$OUTPUT_DIR"
xcrun clang++ -O2 -std=c++17 -fobjc-arc -target "$TARGET" -bundle -undefined dynamic_lookup \
  -framework Foundation -framework CoreLocation \
  "$ROOT_DIR/native/location/main.mm" -o "$OUTPUT_DIR/location.node"
echo "built $OUTPUT_DIR/location.node"
