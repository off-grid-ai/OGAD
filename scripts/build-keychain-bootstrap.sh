#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$ROOT_DIR/native/keychain-bootstrap/main.cc"
OUTPUT_DIR="${1:-$ROOT_DIR/resources/bin}"
OUTPUT="$OUTPUT_DIR/keychain-bootstrap.node"
NATIVE_ARCH="${OFFGRID_NATIVE_ARCH:-$(node -p 'process.arch')}"

mkdir -p "$OUTPUT_DIR"

case "$NATIVE_ARCH" in
  arm64) TARGET="arm64-apple-macos13.0" ;;
  x86_64) TARGET="x86_64-apple-macos13.0" ;;
  *) echo "unsupported macOS architecture: $NATIVE_ARCH" >&2; exit 1 ;;
esac

xcrun clang++ \
  -O2 \
  -std=c++17 \
  -Wno-deprecated-declarations \
  -target "$TARGET" \
  -bundle \
  -undefined dynamic_lookup \
  -framework CoreFoundation \
  -framework Security \
  "$SOURCE" \
  -o "$OUTPUT"
chmod +x "$OUTPUT"
echo "built $OUTPUT"
