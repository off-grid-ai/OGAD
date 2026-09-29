#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="$ROOT/build/image-macos"
SOURCE="$CACHE/source"
DEST="${OFFGRID_SD_DEST:-$ROOT/resources/bin/sd}"
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo '[build-image-macos] Apple Silicon macOS is required' >&2
  exit 1
fi
mkdir -p "$CACHE"
node "$ROOT/scripts/prepare-image-runtime.mjs" "$SOURCE"
cmake -S "$SOURCE" -B "$CACHE/build" -DCMAKE_BUILD_TYPE=Release   -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0   -DSD_METAL=ON -DSD_BUILD_EXAMPLES=ON -DSD_BUILD_SHARED_LIBS=ON   -DSD_BUILD_SHARED_GGML_LIB=OFF -DGGML_NATIVE=OFF -DSD_SERVER_BUILD_FRONTEND=OFF
cmake --build "$CACHE/build" --target sd-cli sd-server --parallel 2
mkdir -p "$DEST"
for name in sd-cli sd-server libstable-diffusion.dylib; do
  install -m 755 "$CACHE/build/bin/$name" "$DEST/.$name.new"
  codesign --force --sign - "$DEST/.$name.new"
  mv -f "$DEST/.$name.new" "$DEST/$name"
done
install -m 644 "$SOURCE/LICENSE" "$DEST/LICENSE"
"$DEST/sd-cli" --version
"$DEST/sd-cli" --list-devices
