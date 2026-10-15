#!/usr/bin/env bash
set -euo pipefail

# Preserve master-889-c678dfe and the existing universal three-file payload.
REF=c678dfe704a2230342376b46add9c8ca736a653d
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${OFFGRID_BUILD_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
DEST="$ROOT/resources/bin/sd"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
[ "$(uname -s)" = Darwin ] || { echo '[build-sd-mac] macOS is required' >&2; exit 1; }

git clone --no-checkout https://github.com/leejet/stable-diffusion.cpp "$WORK/src"
git -C "$WORK/src" checkout --detach "$REF"
git -C "$WORK/src" submodule update --init --recursive
test "$(git -C "$WORK/src" rev-parse HEAD)" = "$REF"
# SD_BUILD_SHARED_GGML_LIB=OFF keeps GGML inside the one existing SD dylib.
cmake -S "$WORK/src" -B "$WORK/build" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 -DCMAKE_OSX_ARCHITECTURES='arm64;x86_64' \
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
          echo "[build-sd-mac] unbundled dependency: $file -> $dep" >&2
          exit 1
        fi
        install_name_tool -change "$dep" "@loader_path/$name" "$file"
        ;;
    esac
  done < <(otool -L "$file" | awk '/compatibility version/ {print $1}' | sort -u)
done
install_name_tool -id @loader_path/libstable-diffusion.dylib "$WORK/stage/libstable-diffusion.dylib"
node "$SCRIPT_DIR/check-macos-minos.mjs" 13.0 "$WORK/stage"
rm -rf "$DEST"
mkdir -p "$DEST"
cp "$WORK/stage/"* "$DEST/"
node "$SCRIPT_DIR/check-macos-minos.mjs" 13.0 "$DEST"
echo '[build-sd-mac] staged universal SD engine for macOS 13+'
