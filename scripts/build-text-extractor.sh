#!/usr/bin/env bash
# Build the SHIPPED accessibility helper (resources/bin/text-extractor) from the
# Swift sources, and gate its macOS deployment target the same way build-llama.sh
# gates the engine.
#
# Why the gate: a binary built on a newer SDK with no deployment target inherits
# `minos` = that SDK (26.0 on current toolchains) and then silently REFUSES to
# launch on older macOS - the app's Accessibility text + the R5 driving rail go
# dark with no error. The app ships minimumSystemVersion 13.0, so this pins the
# helper to 13.0 and fails the build if the result's minos exceeds it.
#
# Run this after changing any scripts/text-extractor/*.swift; commit the rebuilt
# binary (it is git-LFS tracked and shipped prebuilt, see release.yml).
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT_DIR/scripts/text-extractor"
TARGET="13.0"
OUT="$ROOT_DIR/resources/bin/text-extractor"

swiftc -emit-executable -O \
  -target "arm64-apple-macos${TARGET}" \
  "$SRC/main.swift" \
  "$ROOT_DIR/scripts/text-extractor.swift" \
  "$SRC/common.swift" \
  "$SRC/classifiers.swift" \
  "$SRC/claude.swift" \
  "$SRC/generic.swift" \
  "$SRC/chatgpt.swift" \
  "$SRC/gemini.swift" \
  "$SRC/elements.swift" \
  -o "$OUT"

# Gate: minos must not exceed the target, or older macOS silently can't launch it.
MINOS="$(vtool -show-build "$OUT" 2>/dev/null | awk '/minos/{print $2; exit}')"
if [ -z "$MINOS" ]; then
  echo "[build-text-extractor] FATAL: no minos in the built binary"; exit 1
fi
# Compare as sortable versions: the lower of (minos, target) must be minos.
LOWER="$(printf '%s\n%s\n' "$MINOS" "$TARGET" | sort -V | head -1)"
if [ "$LOWER" != "$MINOS" ]; then
  echo "[build-text-extractor] FATAL: minos $MINOS exceeds target $TARGET - would break older macOS"; exit 1
fi
echo "[build-text-extractor] done - minos=$MINOS (target $TARGET), $(lipo -info "$OUT" | sed 's/.*: //')"
