#!/usr/bin/env bash
set -euo pipefail

# Stage pinned upstream Linux x64 servers. Each family has CUDA for NVIDIA,
# Vulkan for other GPUs, and CPU for machines without a working GPU driver.
# The upstream builds include CPU instruction-set variants, unlike one build
# compiled on the release runner. Keep these archive hashes in step with the
# two refs in package.json when updating an engine.
ROOT="${OFFGRID_BUILD_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
VARIANT="${LLAMA_VARIANT:-standard}"
ACCELERATOR="${LLAMA_ACCELERATOR:-vulkan}"

if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo '[build-llama-linux] Linux x64 is required' >&2
  exit 1
fi

case "$VARIANT" in
  standard)
    REF="${LLAMA_REF:-$(node -p "require('$ROOT/package.json').offgrid.llamaRef")}"
    REPO=ggml-org/llama.cpp
    DIR=llama
    if [ "$REF" != b11669 ]; then
      echo '[build-llama-linux] update the pinned standard archive hashes for the new ref' >&2
      exit 1
    fi
    case "$ACCELERATOR" in
      cuda) SHA256=4703ed1a3cd6e8504affb6cb9866f501e96d634d68a002dc9a8251c9e2819b49 ;;
      vulkan) SHA256=e8709e5ba6c1b093dea7f3de57f4aba842f9a188fba6b465782d65d6fcfa4d9f ;;
      cpu) SHA256=cf07c1c112d709bd67e522017471de57ed0ec8bea031d732c5422351c07f65ac ;;
      *) echo "[build-llama-linux] unknown accelerator: $ACCELERATOR" >&2; exit 1 ;;
    esac
    ;;
  prism)
    REF="${PRISM_LLAMA_REF:-$(node -p "require('$ROOT/package.json').offgrid.prismLlamaRef")}"
    REPO=PrismML-Eng/llama.cpp
    DIR=llama-prism
    if [ "$REF" != prism-b10777-e3de715 ]; then
      echo '[build-llama-linux] update the pinned Prism archive hashes for the new ref' >&2
      exit 1
    fi
    case "$ACCELERATOR" in
      cuda) SHA256=aa53e2256276e683386effdc8be34b3bd1cdf64ef9dc5d492da69227ac52531b ;;
      vulkan) SHA256=b53d24c9fcf704656045fa62d2d1500d290da49800aa6ec0066f05f3367af498 ;;
      cpu) SHA256=3f97b6fbec0065fede2be92f05df531c1050636fc2613e1ba0d975249df19713 ;;
      *) echo "[build-llama-linux] unknown accelerator: $ACCELERATOR" >&2; exit 1 ;;
    esac
    ;;
  *) echo "[build-llama-linux] unknown variant: $VARIANT" >&2; exit 1 ;;
esac

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
CUDA_ARCHIVE="cudart-llama-b11669-bin-ubuntu-cuda-12.8-x64.tar.gz"
CUDA_SHA256=ab3eda89a82096bcba00b6448218c3c11eec2016b0f38d64884dc29736549f26
if [ "$ACCELERATOR" = cuda ] &&
  { [ "$(cat "$CUDA_DEST/.archive-sha256" 2>/dev/null || true)" != "$CUDA_SHA256" ] ||
    [ ! -f "$CUDA_DEST/libcudart.so.12" ] ||
    [ ! -f "$CUDA_DEST/libcublas.so.12" ] ||
    [ ! -f "$CUDA_DEST/libcublasLt.so.12" ]; }; then
  CUDA_URL="https://github.com/ggml-org/llama.cpp/releases/download/b11669/$CUDA_ARCHIVE"
  download_archive "$CUDA_URL" "$CUDA_ARCHIVE"
  printf '%s  %s\n' "$CUDA_SHA256" "$WORK/$CUDA_ARCHIVE" | sha256sum --check --status
  tar -xzf "$WORK/$CUDA_ARCHIVE" -C "$WORK"
  rm -rf -- "$CUDA_DEST"
  mkdir -p "$CUDA_DEST"
  cp "$WORK/cudart-llama-b11669-bin-ubuntu-cuda-12.8-x64/"lib*.so.12 "$CUDA_DEST/"
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
