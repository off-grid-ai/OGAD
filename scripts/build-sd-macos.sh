#!/usr/bin/env bash
# Builds the macOS stable-diffusion.cpp runtime (sd-cli, sd-server, libstable-diffusion.dylib) as a
# universal (arm64 + x86_64) Metal build for macOS 13+, and copies it to resources/bin/sd/.
# Upstream's macOS release zip is arm64-only and needs macOS 26, so the app builds its own.
# Both the CI engine archive (build-native-engines.yml) and the release job (release.yml) run this.
#   scripts/build-sd-macos.sh [tag] [work-dir]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${OFFGRID_BUILD_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
TAG="${1:-}"
TARGET="${MACOS_DEPLOYMENT_TARGET:-13.0}"
DEST="${OFFGRID_SD_OUT:-$ROOT/resources/bin/sd}"
[ "$(uname -s)" = Darwin ] || { echo '[build-sd-macos] macOS is required' >&2; exit 1; }

if [ -n "${2:-}" ]; then
  WORK="$2"
  mkdir -p "$WORK"
else
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
fi
rm -rf "$WORK/build" "$WORK/stage"

# The pinned engine (resources/engine-pins.json) with the video decode-preview patches; a tag
# argument overrides the pin.
PREPARE_ARGS=("$WORK/src")
if [ -n "$TAG" ]; then PREPARE_ARGS+=("$TAG"); fi
node "$SCRIPT_DIR/prepare-image-runtime.mjs" "${PREPARE_ARGS[@]}"

# ggml-blas asks Accelerate for its new LAPACK interface, which exists only on macOS 13.3+; below that
# it is weak-linked and the first CPU matrix multiply calls null. Use the classic interface there.
BLAS_FLAGS=""
if awk -v t="$TARGET" 'BEGIN { split(t, p, "."); exit !((p[1] + 0) < 13 || ((p[1] + 0) == 13 && (p[2] + 0) < 3)) }'; then
  BLAS_FLAGS="-UACCELERATE_NEW_LAPACK -UACCELERATE_LAPACK_ILP64"
fi
# SD_BUILD_SHARED_GGML_LIB=OFF keeps GGML inside the one existing SD dylib.
cmake -S "$WORK/src" -B "$WORK/build" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS="$BLAS_FLAGS" -DCMAKE_CXX_FLAGS="$BLAS_FLAGS" \
  -DCMAKE_OSX_DEPLOYMENT_TARGET="$TARGET" -DCMAKE_OSX_ARCHITECTURES='arm64;x86_64' \
  -DSD_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_NATIVE=OFF \
  -DGGML_OPENMP=OFF -DSD_BUILD_SHARED_LIBS=ON -DSD_BUILD_SHARED_GGML_LIB=OFF \
  -DSD_BUILD_EXAMPLES=ON -DCMAKE_DISABLE_FIND_PACKAGE_OpenSSL=ON \
  -DCMAKE_DISABLE_FIND_PACKAGE_CURL=ON
cmake --build "$WORK/build" --config Release -j"$(sysctl -n hw.ncpu)" \
  --target sd-cli sd-server stable-diffusion

mkdir -p "$WORK/stage"
for name in sd-cli sd-server libstable-diffusion.dylib; do
  source="$(find "$WORK/build" -name "$name" -type f -print -quit)"
  test -n "$source"
  cp "$source" "$WORK/stage/$name"
  lipo "$WORK/stage/$name" -verify_arch arm64 x86_64
done
# The binaries load the dylib from their own folder (the app spawns them with cwd = that folder).
for file in "$WORK/stage/"*; do
  while IFS= read -r rpath; do
    install_name_tool -delete_rpath "$rpath" "$file"
  done < <(otool -l "$file" | awk '/cmd LC_RPATH/{found=1; next} found && $1 == "path" {print $2; found=0}' | sort -u)
  install_name_tool -add_rpath @loader_path "$file"
  while IFS= read -r dep; do
    case "$dep" in
      /System/Library/*|/usr/lib/*) ;;
      *)
        name="$(basename "$dep")"
        if [ ! -f "$WORK/stage/$name" ]; then
          echo "[build-sd-macos] unbundled dependency: $file -> $dep" >&2
          exit 1
        fi
        install_name_tool -change "$dep" "@loader_path/$name" "$file"
        ;;
    esac
  done < <(otool -L "$file" | awk '/compatibility version/ {print $1}' | sort -u)
done
install_name_tool -id @loader_path/libstable-diffusion.dylib "$WORK/stage/libstable-diffusion.dylib"
# install_name_tool invalidates the signature, so sign last; the release job re-signs with its identity.
codesign --force --sign - "$WORK/stage/libstable-diffusion.dylib" \
  "$WORK/stage/sd-cli" "$WORK/stage/sd-server"
node "$SCRIPT_DIR/check-macos-minos.mjs" "$TARGET" "$WORK/stage"
rm -rf "$DEST"
mkdir -p "$DEST"
cp "$WORK/stage/"* "$DEST/"
node "$SCRIPT_DIR/check-macos-minos.mjs" "$TARGET" "$DEST"
echo "[build-sd-macos] staged universal SD engine for macOS $TARGET+ in $DEST"
lipo -info "$DEST/sd-server"
