#!/usr/bin/env bash
# Compile the native actions helper (EventKit / Reminders / Contacts / Photos), the
# backend of the computer-use semantic rail. Output lands next to the source so dev
# mode finds it; CI copies it into resources/bin so extraResources bundles it at
# Contents/Resources/bin. Pinned to the same deployment target as every other bundled
# native binary (macOS 13) so it launches on the versions the app advertises.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$ROOT_DIR/actions-helper/main.swift"
OUT="$ROOT_DIR/actions-helper/actions-helper"
swiftc -O -target arm64-apple-macos13.0 -emit-executable "$SRC" -o "$OUT"
echo "built $OUT"
