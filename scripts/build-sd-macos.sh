#!/usr/bin/env bash
# Builds the macOS stable-diffusion.cpp runtime (sd-cli, sd-server, libstable-diffusion.dylib) as a
# universal (arm64 + x86_64) Metal build for macOS 13+, and copies it to resources/bin/sd/.
# Upstream's macOS release zip is arm64-only and needs macOS 26, so the app builds its own.
#   scripts/build-sd-macos.sh [tag] [work-dir]
set -euo pipefail
TAG="${1:-master-968-8cd731e}"
TARGET="${MACOS_DEPLOYMENT_TARGET:-13.0}"
WORK="${2:-${TMPDIR:-/tmp}/offgrid-sd-build}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${OFFGRID_SD_OUT:-$ROOT/resources/bin/sd}"

rm -rf "$WORK/src" "$WORK/build"
mkdir -p "$WORK"
git clone --quiet --depth 1 --branch "$TAG" --recurse-submodules --shallow-submodules \
  https://github.com/leejet/stable-diffusion.cpp "$WORK/src"

# ggml-blas asks Accelerate for its new LAPACK interface, which exists only on macOS 13.3+; below that
# it is weak-linked and the first CPU matrix multiply calls null. Use the classic interface there.
BLAS_FLAGS=""
if awk -v t="$TARGET" 'BEGIN { split(t, p, "."); exit !((p[1] + 0) < 13 || ((p[1] + 0) == 13 && (p[2] + 0) < 3)) }'; then
  BLAS_FLAGS="-UACCELERATE_NEW_LAPACK -UACCELERATE_LAPACK_ILP64"
fi
cmake -S "$WORK/src" -B "$WORK/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS="$BLAS_FLAGS" -DCMAKE_CXX_FLAGS="$BLAS_FLAGS" \
  -DCMAKE_OSX_ARCHITECTURES="arm64;x86_64" \
  -DCMAKE_OSX_DEPLOYMENT_TARGET="$TARGET" \
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
