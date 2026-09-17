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
INFO_PLIST="$ROOT_DIR/actions-helper-Info.plist"
swiftc -O -target arm64-apple-macos13.0 -emit-executable "$SRC" -o "$OUT" \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$INFO_PLIST"
# swiftc adds a linker signature, but Core Location needs a verifiable designated
# requirement in development builds. Release packaging replaces this ad-hoc signature.
codesign --force --sign - --identifier ai.offgrid.desktop.actions-helper "$OUT"
echo "built $OUT"
