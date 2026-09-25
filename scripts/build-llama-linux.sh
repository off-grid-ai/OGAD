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
    if [ "$REF" != b11056 ]; then
      echo '[build-llama-linux] update the pinned standard archive hashes for the new ref' >&2
      exit 1
    fi
    case "$ACCELERATOR" in
      cuda) SHA256=bc44772a8186efa778d8ed8ccf74964d42afd04d5b032f6f3a9076820cd2de70 ;;
      vulkan) SHA256=9edceb8555da0bb24fe4f7fa531954461a17c3ac32a674d96ecaf0a6321305c8 ;;
      cpu) SHA256=74936888e975064d07e352745237508d4bef08d4b51843b01d011d58a4c4601a ;;
      *) echo "[build-llama-linux] unknown accelerator: $ACCELERATOR" >&2; exit 1 ;;
    esac
    ;;
  prism)
    REF="${PRISM_LLAMA_REF:-$(node -p "require('$ROOT/package.json').offgrid.prismLlamaRef")}"
    REPO=PrismML-Eng/llama.cpp
    DIR=llama-prism
    if [ "$REF" != prism-b10709-9a9394a ]; then
      echo '[build-llama-linux] update the pinned Prism archive hashes for the new ref' >&2
      exit 1
    fi
    case "$ACCELERATOR" in
      cuda) SHA256=8aec67eb023b251712c7e6490f367b5671bf587eced1436a9b85f4a90c3b7d3d ;;
      vulkan) SHA256=4d7f858539d0207cf64e90beb83fcb7e076580d52856580f223cbecdd3ef6d03 ;;
      cpu) SHA256=48b487f00fd2b27bc3ef77c701b43c1c23a4af484d2a203ae87d0efc41506728 ;;
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
CUDA_ARCHIVE="cudart-llama-b11056-bin-ubuntu-cuda-12.8-x64.tar.gz"
CUDA_SHA256=9fba31d628eca3672b187da52aab123e9c9c04b376ccf5408d283ecaae4c0891
if [ "$ACCELERATOR" = cuda ] &&
  { [ "$(cat "$CUDA_DEST/.archive-sha256" 2>/dev/null || true)" != "$CUDA_SHA256" ] ||
    [ ! -f "$CUDA_DEST/libcudart.so.12" ] ||
    [ ! -f "$CUDA_DEST/libcublas.so.12" ] ||
    [ ! -f "$CUDA_DEST/libcublasLt.so.12" ]; }; then
  CUDA_URL="https://github.com/ggml-org/llama.cpp/releases/download/b11056/$CUDA_ARCHIVE"
  download_archive "$CUDA_URL" "$CUDA_ARCHIVE"
  printf '%s  %s\n' "$CUDA_SHA256" "$WORK/$CUDA_ARCHIVE" | sha256sum --check --status
  tar -xzf "$WORK/$CUDA_ARCHIVE" -C "$WORK"
  rm -rf -- "$CUDA_DEST"
  mkdir -p "$CUDA_DEST"
  cp "$WORK/cudart-llama-b11056-bin-ubuntu-cuda-12.8-x64/"lib*.so.12 "$CUDA_DEST/"
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

# Upstream Ubuntu servers need libgomp. Put the Ubuntu 22.04 runtime next to
# each server so an AppImage does not depend on the user's distro installing it.
GOMP="$(ldconfig -p | awk '/libgomp\.so\.1 / && !found { found=$NF } END { print found }')"
test -n "$GOMP"
cp -L "$GOMP" "$DEST/libgomp.so.1"
chmod +x "$DEST/llama-server"

file "$DEST/llama-server" | grep -q 'ELF 64-bit.*x86-64'
LIBRARY_PATH="$DEST"
if [ "$ACCELERATOR" = cuda ]; then LIBRARY_PATH="$DEST:$CUDA_DEST"; fi
if [ "$ACCELERATOR" = cuda ]; then
  # The pinned standard CUDA build requires GLIBC 2.38 (Ubuntu 24.04). This
  # release runner is Ubuntu 22.04 to keep CPU/Vulkan usable there. CI executes
  # both staged CUDA servers in an Ubuntu 24.04 container after packaging.
  echo '[build-llama-linux] staged CUDA engine; Ubuntu 24.04 load check runs in release CI'
  exit 0
fi
DEPS="$(LD_LIBRARY_PATH="$LIBRARY_PATH" ldd "$DEST/llama-server")"
if printf '%s\n' "$DEPS" | grep -q 'not found'; then
  printf '%s\n' "$DEPS" >&2
  exit 1
fi
LD_LIBRARY_PATH="$LIBRARY_PATH" "$DEST/llama-server" --version
LD_LIBRARY_PATH="$LIBRARY_PATH" "$DEST/llama-server" --list-devices
