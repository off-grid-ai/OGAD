#!/usr/bin/env bash
set -euo pipefail

# Stage pinned upstream Linux x64 servers. Each family has CUDA for NVIDIA,
# Vulkan for other GPUs, and CPU for machines without a working GPU driver.
# The upstream builds include CPU instruction-set variants, unlike one build
# compiled on the release runner. Refs and archive hashes live in
# resources/engine-pins.json (scripts/update-engine-pins.mjs rewrites it).
ROOT="${OFFGRID_BUILD_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
PINS="$(cd "$(dirname "$0")/.." && pwd)/resources/engine-pins.json"
VARIANT="${LLAMA_VARIANT:-standard}"
ACCELERATOR="${LLAMA_ACCELERATOR:-vulkan}"
pin() { node -p "require('$PINS').$1"; }

if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo '[build-llama-linux] Linux x64 is required' >&2
  exit 1
fi

case "$VARIANT" in
  standard) ENGINE=llama; REF="${LLAMA_REF:-$(pin llama.ref)}"; DIR=llama ;;
  prism) ENGINE=prism; REF="${PRISM_LLAMA_REF:-$(pin prism.ref)}"; DIR=llama-prism ;;
  *) echo "[build-llama-linux] unknown variant: $VARIANT" >&2; exit 1 ;;
esac
case "$ACCELERATOR" in
  cuda|vulkan|cpu) ;;
  *) echo "[build-llama-linux] unknown accelerator: $ACCELERATOR" >&2; exit 1 ;;
esac
REPO="$(pin "$ENGINE.repo")"
# A ref other than the pinned one must bring its own hash.
if [ "$REF" = "$(pin "$ENGINE.ref")" ]; then
  SHA256="$(pin "$ENGINE.sha256['linux-$ACCELERATOR']")"
else
  SHA256="${LLAMA_SHA256:?[build-llama-linux] LLAMA_SHA256 is required for an unpinned ref}"
fi

case "$ACCELERATOR" in
  cuda)
    if [ "$VARIANT" = prism ]; then
      ARCHIVE="llama-$REF-bin-linux-cuda-12.8-x64.tar.gz"
    else
      ARCHIVE="llama-$REF-bin-ubuntu-cuda-12.8-x64.tar.gz"
    fi
    DIR="$DIR-cuda"
    ;;
  vulkan) ARCHIVE="llama-$REF-bin-ubuntu-vulkan-x64.tar.gz" ;;
  cpu) ARCHIVE="llama-$REF-bin-ubuntu-x64.tar.gz"; DIR="$DIR-cpu" ;;
esac

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
download_archive() {
  local url="$1" archive="$2"
  if [ -n "${OFFGRID_LLAMA_ARCHIVE_CACHE_DIR:-}" ] &&
    [ -f "$OFFGRID_LLAMA_ARCHIVE_CACHE_DIR/$archive" ]; then
    cp "$OFFGRID_LLAMA_ARCHIVE_CACHE_DIR/$archive" "$WORK/$archive"
  else
    curl --fail --location --retry 3 --silent --show-error "$url" --output "$WORK/$archive"
  fi
}
CUDA_DEST="$ROOT/build/linux-bin/cuda-runtime"
CUDART_REF="$(pin llama.ref)"
CUDA_ARCHIVE="cudart-llama-$CUDART_REF-bin-ubuntu-cuda-12.8-x64.tar.gz"
CUDA_SHA256="$(pin "llama.sha256['linux-cudart']")"
if [ "$ACCELERATOR" = cuda ] &&
  { [ "$(cat "$CUDA_DEST/.archive-sha256" 2>/dev/null || true)" != "$CUDA_SHA256" ] ||
    [ ! -f "$CUDA_DEST/libcudart.so.12" ] ||
    [ ! -f "$CUDA_DEST/libcublas.so.12" ] ||
    [ ! -f "$CUDA_DEST/libcublasLt.so.12" ]; }; then
  CUDA_URL="https://github.com/ggml-org/llama.cpp/releases/download/$CUDART_REF/$CUDA_ARCHIVE"
  download_archive "$CUDA_URL" "$CUDA_ARCHIVE"
  printf '%s  %s\n' "$CUDA_SHA256" "$WORK/$CUDA_ARCHIVE" | sha256sum --check --status
  tar -xzf "$WORK/$CUDA_ARCHIVE" -C "$WORK"
  rm -rf -- "$CUDA_DEST"
  mkdir -p "$CUDA_DEST"
  cp "$WORK/${CUDA_ARCHIVE%.tar.gz}/"lib*.so.12 "$CUDA_DEST/"
  printf '%s\n' "$CUDA_SHA256" > "$CUDA_DEST/.archive-sha256"
fi
URL="https://github.com/$REPO/releases/download/$REF/$ARCHIVE"
download_archive "$URL" "$ARCHIVE"
printf '%s  %s\n' "$SHA256" "$WORK/$ARCHIVE" | sha256sum --check --status
tar -xzf "$WORK/$ARCHIVE" -C "$WORK"
SOURCE="$WORK/llama-$REF"
test -x "$SOURCE/llama-server"
if [ "$ACCELERATOR" = vulkan ]; then test -f "$SOURCE/libggml-vulkan.so"; fi
if [ "$ACCELERATOR" = cuda ]; then test -f "$SOURCE/libggml-cuda.so"; fi

DEST="$ROOT/build/linux-bin/$DIR"
rm -rf -- "$DEST"
mkdir -p "$DEST"
cp "$SOURCE/llama-server" "$DEST/"
# Preserve versioned .so symlinks. Dereferencing each name duplicates hundreds
# of megabytes of Prism's CUDA backend inside every installer.
cp -a "$SOURCE"/lib*.so* "$DEST/"
cp "$SOURCE/LICENSE" "$DEST/"

# Upstream Ubuntu servers need libgomp. Put the release runner's runtime next
# to each server so an AppImage does not depend on the user's distro installing it.
GOMP="$(ldconfig -p | awk '/libgomp\.so\.1 / && !found { found=$NF } END { print found }')"
test -n "$GOMP"
cp -L "$GOMP" "$DEST/libgomp.so.1"
if [ "$ACCELERATOR" = vulkan ]; then
  VULKAN="$(ldconfig -p | awk '$1 == "libvulkan.so.1" && /x86-64/ && !found { found=$NF } END { print found }')"
  test -n "$VULKAN"
  install -m 755 "$(readlink -f "$VULKAN")" "$DEST/libvulkan.so.1"
fi
chmod +x "$DEST/llama-server"

file "$DEST/llama-server" | grep -q 'ELF 64-bit.*x86-64'
LIBRARY_PATH="$DEST"
if [ "$ACCELERATOR" = cuda ]; then LIBRARY_PATH="$DEST:$CUDA_DEST"; fi
if [ "$ACCELERATOR" = cuda ]; then
  # CUDA requires the host NVIDIA driver; CI checks bundled dependencies after
  # packaging, and a physical NVIDIA machine must confirm device enumeration.
  echo '[build-llama-linux] staged CUDA engine; packaged dependencies checked in release CI'
  exit 0
fi
DEPS="$(LD_LIBRARY_PATH="$LIBRARY_PATH" ldd "$DEST/llama-server")"
if printf '%s\n' "$DEPS" | grep -q 'not found'; then
  printf '%s\n' "$DEPS" >&2
  exit 1
fi
LD_LIBRARY_PATH="$LIBRARY_PATH" "$DEST/llama-server" --version
LD_LIBRARY_PATH="$LIBRARY_PATH" "$DEST/llama-server" --list-devices
