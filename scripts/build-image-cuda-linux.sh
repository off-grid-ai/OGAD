#!/usr/bin/env bash
set -euo pipefail

# Match the Vulkan image runtime source while adding a separate NVIDIA engine.
ROOT="${OFFGRID_BUILD_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
SD_REF=master-920-2f88688
SD_COMMIT=2f886889e6e8b78738d6b87f7191f6018557c551
CUDA_BUILD_IMAGE=nvidia/cuda:12.8.1-devel-ubuntu24.04@sha256:4b9ed5fa8361736996499f64ecebf25d4ec37ff56e4d11323ccde10aa36e0c43

if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo '[build-image-cuda-linux] Linux x64 is required' >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
git clone --depth 1 --branch "$SD_REF" --recurse-submodules \
  https://github.com/leejet/stable-diffusion.cpp "$WORK/src"
test "$(git -C "$WORK/src" rev-parse HEAD)" = "$SD_COMMIT"
mkdir -p "$WORK/build"
DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then DOCKER=(sudo docker); fi
CUDA_ARCHITECTURES="${OFFGRID_CUDA_ARCHITECTURES:-61;70;75;80;86;89;90}"
"${DOCKER[@]}" run --rm --platform linux/amd64 \
  -e CUDA_ARCHITECTURES="$CUDA_ARCHITECTURES" \
  -v "$WORK/src:/src:ro" -v "$WORK/build:/build" \
  "$CUDA_BUILD_IMAGE" bash -euo pipefail -c '
    trap "chmod -R a+rwX /build" EXIT
    apt-get update -qq
    apt-get install -y --no-install-recommends cmake build-essential git
    cmake -S /src -B /build -DCMAKE_BUILD_TYPE=Release \
      -DSD_CUDA=ON -DSD_VULKAN=OFF -DSD_BUILD_EXAMPLES=ON -DSD_SERVER_BUILD_FRONTEND=OFF \
      -DSD_BUILD_SHARED_LIBS=OFF -DSD_BUILD_SHARED_GGML_LIB=OFF \
      -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF \
      -DGGML_CUDA_NCCL=OFF -DCMAKE_CUDA_ARCHITECTURES="$CUDA_ARCHITECTURES"
    cmake --build /build --config Release --parallel 4 --target sd-cli sd-server
  '

DEST="$ROOT/build/linux-bin/sd-cuda"
mkdir -p "$DEST"
for name in sd-cli sd-server; do
  binary="$(find "$WORK/build" -name "$name" -type f -perm -111 -print -quit)"
  test -n "$binary"
  install -m 755 "$binary" "$DEST/$name"
  file "$DEST/$name" | grep -q 'ELF 64-bit.*x86-64'
  dependencies="$(LD_LIBRARY_PATH="$DEST:$ROOT/build/linux-bin/cuda-runtime" ldd "$DEST/$name")"
  missing="$(printf '%s\n' "$dependencies" | grep 'not found' | grep -v 'libcuda.so.1' || true)"
  test -z "$missing" || { printf '%s\n' "$missing" >&2; exit 1; }
done
install -m 644 "$WORK/src/LICENSE" "$DEST/LICENSE"
echo '[build-image-cuda-linux] staged CUDA image CLI and server'
