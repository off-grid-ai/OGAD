#!/usr/bin/env bash
# Compile the native meeting recorder (ScreenCaptureKit + AVFoundation).
# Output lands next to the source so dev mode finds it, and electron-builder
# copies it into the packaged app's resources/bin.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$ROOT_DIR/meeting-recorder/main.swift"
OUT="$ROOT_DIR/meeting-recorder/meeting-recorder"
swiftc -O -target arm64-apple-macos13.0 -emit-executable "$SRC" -o "$OUT"
echo "built $OUT"
