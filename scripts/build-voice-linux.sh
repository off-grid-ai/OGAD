#!/usr/bin/env bash
set -euo pipefail

# Stage the Linux x64 transcription tools that core Chat and file ingestion use.
# Pin the Whisper source and FFmpeg release asset so a later upstream build cannot
# silently change an installer. Stage CUDA, Vulkan, and CPU binaries separately.
ROOT="${OFFGRID_BUILD_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
WHISPER_REF=b5130
WHISPER_COMMIT=927cfce34f31707e17f2bff35c349632fb9e2c3a
CUDA_BUILD_IMAGE=nvidia/cuda:12.8.1-devel-ubuntu24.04@sha256:4b9ed5fa8361736996499f64ecebf25d4ec37ff56e4d11323ccde10aa36e0c43
FFMPEG_ARCHIVE=ffmpeg-n8.1.3-linux64-lgpl-8.1.tar.xz
FFMPEG_SHA256=5804347ca94249ceee74dd8c77dd3fa978d7d100808bebcd4889cd24eb89c004
FFMPEG_DIR=ffmpeg-n8.1.3-linux64-lgpl-8.1

if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo '[build-voice-linux] Linux x64 is required' >&2
  exit 1
fi

# The CUDA, Vulkan, and CPU binaries came from a successful pinned Linux CI build.
# CI downloads this exact checked archive instead of compiling
# Whisper in a fresh runner. Set OFFGRID_BUILD_VOICE_FROM_SOURCE=1 to regenerate it.
if [ "${OFFGRID_BUILD_VOICE_FROM_SOURCE:-0}" != 1 ] &&
  [ "${OFFGRID_REUSE_STAGED_VOICE:-0}" != 1 ]; then
  VOICE_ARCHIVE="ogad-whisper-${WHISPER_REF}-linux-x64-cuda12.8-multiarch-v1.tar.gz"
  VOICE_SHA256=ba6fe2d08fa75589cb86b01c06e2f16b8483b81d19949b2035289d8bc0ff3c77
  VOICE_WORK="$(mktemp -d)"
  trap 'rm -rf -- "$VOICE_WORK"' EXIT
  if [ -n "${OFFGRID_VOICE_ARCHIVE_CACHE_DIR:-}" ] &&
    [ -f "$OFFGRID_VOICE_ARCHIVE_CACHE_DIR/$VOICE_ARCHIVE" ]; then
    cp "$OFFGRID_VOICE_ARCHIVE_CACHE_DIR/$VOICE_ARCHIVE" "$VOICE_WORK/$VOICE_ARCHIVE"
  else
    curl --fail --location --retry 3 --silent --show-error \
      "https://github.com/off-grid-ai/OGAD/releases/download/native-deps-2026-09/$VOICE_ARCHIVE" \
      --output "$VOICE_WORK/$VOICE_ARCHIVE"
  fi
  printf '%s  %s\n' "$VOICE_SHA256" "$VOICE_WORK/$VOICE_ARCHIVE" | sha256sum --check --status
  mkdir -p "$ROOT/build/linux-bin"
  tar -xzf "$VOICE_WORK/$VOICE_ARCHIVE" -C "$ROOT/build/linux-bin" --no-same-owner
  OFFGRID_REUSE_STAGED_VOICE=1
fi
if [ "${OFFGRID_REUSE_STAGED_VOICE:-0}" = 1 ]; then
  for binary in "$ROOT/build/linux-bin/whisper-cuda/whisper-cli" \
    "$ROOT/build/linux-bin/whisper/whisper-cli" \
    "$ROOT/build/linux-bin/whisper-cpu/whisper-cli" \
    "$ROOT/build/linux-bin/ffmpeg"; do
    test -x "$binary"
    file "$binary" | grep -q 'ELF 64-bit.*x86-64'
    dependencies="$(LD_LIBRARY_PATH="$ROOT/build/linux-bin/cuda-runtime" ldd "$binary")"
    test -z "$(printf '%s\n' "$dependencies" | grep 'not found' | grep -v 'libcuda.so.1' || true)"
  done
  test -f "$ROOT/build/linux-bin/whisper/LICENSE"
  test -f "$ROOT/build/linux-bin/licenses/ffmpeg.txt"
  test -f "$ROOT/build/linux-bin/cuda-runtime/libcudart.so.12"
  "$ROOT/build/linux-bin/ffmpeg" -version >/dev/null
  echo '[build-voice-linux] reusing verified staged Whisper and FFmpeg'
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
git clone --depth 1 --branch "$WHISPER_REF" \
  https://github.com/ggml-org/whisper.cpp "$WORK/whisper"
test "$(git -C "$WORK/whisper" rev-parse HEAD)" = "$WHISPER_COMMIT"

# The release runner has no CUDA compiler. Build in a pinned CUDA toolkit
# container; the installed app uses the existing packaged CUDA 12 runtime.
mkdir -p "$WORK/whisper-build-cuda"
DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then DOCKER=(sudo docker); fi
CUDA_ARCHITECTURES="${OFFGRID_CUDA_ARCHITECTURES:-61;70;75;80;86;89;90}"
"${DOCKER[@]}" run --rm --platform linux/amd64 \
  -e CUDA_ARCHITECTURES="$CUDA_ARCHITECTURES" \
  -v "$WORK/whisper:/src:ro" -v "$WORK/whisper-build-cuda:/build" \
  "$CUDA_BUILD_IMAGE" bash -euo pipefail -c '
    trap "chmod -R a+rwX /build" EXIT
    apt-get update -qq
    apt-get install -y --no-install-recommends cmake build-essential git
    # Whisper configures its JavaScript package in the source tree. Keep the
    # host checkout read-only and give CMake a writable container-local copy.
    cp -R /src /tmp/whisper-src
    cmake -S /tmp/whisper-src -B /build -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF \
      -DGGML_AVX=OFF -DGGML_AVX2=OFF -DGGML_FMA=OFF -DGGML_F16C=OFF \
      -DCMAKE_CUDA_ARCHITECTURES="$CUDA_ARCHITECTURES" \
      -DGGML_CUDA=ON -DGGML_CUDA_NCCL=OFF -DGGML_VULKAN=OFF \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
      -DWHISPER_BUILD_SERVER=OFF
    cmake --build /build --config Release --parallel 4 --target whisper-cli
  '
WHISPER_CUDA_BIN="$(find "$WORK/whisper-build-cuda" -name whisper-cli -type f -perm -111 -print -quit)"
test -n "$WHISPER_CUDA_BIN"

cmake -S "$WORK/whisper" -B "$WORK/whisper-build-vulkan" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF -DGGML_BLAS=OFF \
  -DGGML_AVX=OFF -DGGML_AVX2=OFF -DGGML_FMA=OFF -DGGML_F16C=OFF \
  -DGGML_CUDA=OFF -DGGML_VULKAN=ON \
  -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
  -DWHISPER_BUILD_SERVER=OFF
cmake --build "$WORK/whisper-build-vulkan" --config Release \
  --parallel "${OFFGRID_BUILD_JOBS:-4}" --target whisper-cli
WHISPER_VULKAN_BIN="$(find "$WORK/whisper-build-vulkan" -name whisper-cli -type f -perm -111 -print -quit)"
test -n "$WHISPER_VULKAN_BIN"

# Keep a binary with no Vulkan loader dependency for old/headless systems.
cmake -S "$WORK/whisper" -B "$WORK/whisper-build-cpu" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF -DGGML_BLAS=OFF \
  -DGGML_AVX=OFF -DGGML_AVX2=OFF -DGGML_FMA=OFF -DGGML_F16C=OFF \
  -DGGML_CUDA=OFF -DGGML_VULKAN=OFF \
  -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
  -DWHISPER_BUILD_SERVER=OFF
cmake --build "$WORK/whisper-build-cpu" --config Release \
  --parallel "${OFFGRID_BUILD_JOBS:-4}" --target whisper-cli
WHISPER_CPU_BIN="$(find "$WORK/whisper-build-cpu" -name whisper-cli -type f -perm -111 -print -quit)"
test -n "$WHISPER_CPU_BIN"

if [ -n "${OFFGRID_FFMPEG_ARCHIVE_CACHE_DIR:-}" ] &&
  [ -f "$OFFGRID_FFMPEG_ARCHIVE_CACHE_DIR/$FFMPEG_ARCHIVE" ]; then
  cp "$OFFGRID_FFMPEG_ARCHIVE_CACHE_DIR/$FFMPEG_ARCHIVE" "$WORK/$FFMPEG_ARCHIVE"
else
  curl --fail --location --retry 3 --silent --show-error \
    "https://github.com/off-grid-ai/OGAD/releases/download/native-deps-2026-09/$FFMPEG_ARCHIVE" \
    --output "$WORK/$FFMPEG_ARCHIVE"
fi
printf '%s  %s\n' "$FFMPEG_SHA256" "$WORK/$FFMPEG_ARCHIVE" | sha256sum --check --status
tar -xJf "$WORK/$FFMPEG_ARCHIVE" -C "$WORK" \
  "$FFMPEG_DIR/bin/ffmpeg" "$FFMPEG_DIR/LICENSE.txt"

BIN="$ROOT/build/linux-bin"
mkdir -p "$BIN/whisper-cuda" "$BIN/whisper" "$BIN/whisper-cpu" "$BIN/licenses"
install -m 755 "$WHISPER_CUDA_BIN" "$BIN/whisper-cuda/whisper-cli"
install -m 755 "$WHISPER_VULKAN_BIN" "$BIN/whisper/whisper-cli"
install -m 755 "$WHISPER_CPU_BIN" "$BIN/whisper-cpu/whisper-cli"
install -m 644 "$WORK/whisper/LICENSE" "$BIN/whisper/LICENSE"
install -m 755 "$WORK/$FFMPEG_DIR/bin/ffmpeg" "$BIN/ffmpeg"
install -m 644 "$WORK/$FFMPEG_DIR/LICENSE.txt" "$BIN/licenses/ffmpeg.txt"

for executable in "$BIN/whisper-cuda/whisper-cli" "$BIN/whisper/whisper-cli" "$BIN/whisper-cpu/whisper-cli" "$BIN/ffmpeg"; do
  file "$executable" | grep -q 'ELF 64-bit.*x86-64'
  library_path="$BIN/whisper-cuda:$BIN/cuda-runtime"
  dependencies="$(LD_LIBRARY_PATH="$library_path" ldd "$executable")"
  # libcuda comes from the user's NVIDIA driver and is absent on the build host.
  missing="$(printf '%s\n' "$dependencies" | grep 'not found' | grep -v 'libcuda.so.1' || true)"
  if [ -n "$missing" ]; then
    printf '%s\n' "$missing" >&2
    exit 1
  fi
done
"$BIN/ffmpeg" -version >/dev/null
test -f "$BIN/cuda-runtime/libcudart.so.12"
"$BIN/whisper/whisper-cli" --help >/dev/null 2>&1
"$BIN/whisper-cpu/whisper-cli" --help >/dev/null 2>&1
echo '[build-voice-linux] staged CUDA, Vulkan, and CPU Whisper plus FFmpeg'
