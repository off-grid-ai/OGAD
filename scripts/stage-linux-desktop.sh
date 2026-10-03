#!/usr/bin/env bash
set -euo pipefail
# KWin window IDs are distinct from X11 IDs. Bundle the pinned native query tool.
TASK_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TASK_DEST="$TASK_ROOT/resources/linux-desktop/bin"
TASK_SHA=2079cc1d492b6e83e04def4d9376e34fcb36a4e3bdc637c8c2ee6fa547ce90ff
if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo 'Linux x64 is required to stage the KDE window helper.' >&2
  exit 1
fi
TASK_TEMP="$(mktemp -d)"
trap 'rm -rf -- "$TASK_TEMP"' EXIT
curl --fail --location --retry 3 --silent --show-error \
  https://github.com/jinliu/kdotool/releases/download/v0.3.0/kdotool-0.3.0-x86_64-unknown-linux-gnu.tar.gz \
  --output "$TASK_TEMP/kdotool.tar.gz"
printf '%s  %s\n' "$TASK_SHA" "$TASK_TEMP/kdotool.tar.gz" | sha256sum --check --status
tar -xzf "$TASK_TEMP/kdotool.tar.gz" -C "$TASK_TEMP" --no-same-owner
mkdir -p "$TASK_DEST"
install -m755 "$TASK_TEMP/kdotool" "$TASK_DEST/kdotool"
install -m644 "$TASK_TEMP/LICENSE" "$TASK_DEST/kdotool.LICENSE"
