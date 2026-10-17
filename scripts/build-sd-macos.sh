#!/usr/bin/env bash
# Builds the macOS stable-diffusion.cpp runtime (sd-cli, sd-server, libstable-diffusion.dylib) as a
# universal (arm64 + x86_64) Metal build for macOS 15+, and copies it to resources/bin/sd/.
# Upstream's macOS release zip is arm64-only and needs macOS 26, so the app builds its own.
#   scripts/build-sd-macos.sh [tag] [work-dir]
set -euo pipefail
TAG="${1:-master-968-8cd731e}"
WORK="${2:-${TMPDIR:-/tmp}/offgrid-sd-build}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${OFFGRID_SD_OUT:-$ROOT/resources/bin/sd}"

rm -rf "$WORK/src" "$WORK/build"
mkdir -p "$WORK"
git clone --quiet --depth 1 --branch "$TAG" --recurse-submodules --shallow-submodules \
  https://github.com/leejet/stable-diffusion.cpp "$WORK/src"

cmake -S "$WORK/src" -B "$WORK/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES="arm64;x86_64" \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=15.0 \
  -DSD_METAL=ON \
  -DSD_BUILD_SHARED_LIBS=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DGGML_NATIVE=OFF
cmake --build "$WORK/build" --config Release -j "$(sysctl -n hw.ncpu)"

mkdir -p "$OUT"
cp "$WORK/build/bin/sd-cli" "$WORK/build/bin/sd-server" "$OUT/"
cp "$(find "$WORK/build" -name 'libstable-diffusion.dylib' -type f | head -1)" "$OUT/"
# The binaries load the dylib from their own folder (the app spawns them with cwd = that folder).
for bin in sd-cli sd-server; do
  install_name_tool -add_rpath @executable_path "$OUT/$bin" 2>/dev/null || true
done
codesign --force --sign - "$OUT/libstable-diffusion.dylib" "$OUT/sd-cli" "$OUT/sd-server"
echo "Built $TAG into $OUT"
lipo -info "$OUT/sd-server"
