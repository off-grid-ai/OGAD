#!/usr/bin/env bash
set -euo pipefail

# Stage the Linux x64 transcription tools that core Chat and file ingestion use.
# Pin the Whisper source and FFmpeg release asset so a later upstream build cannot
# silently change an installer. Linux uses the newer Vulkan-capable Whisper build.
ROOT="${OFFGRID_BUILD_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
WHISPER_REF=b5130
WHISPER_COMMIT=927cfce34f31707e17f2bff35c349632fb9e2c3a
FFMPEG_ARCHIVE=ffmpeg-n8.1.3-linux64-lgpl-8.1.tar.xz
FFMPEG_SHA256=5804347ca94249ceee74dd8c77dd3fa978d7d100808bebcd4889cd24eb89c004
FFMPEG_DIR=ffmpeg-n8.1.3-linux64-lgpl-8.1

if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo '[build-voice-linux] Linux x64 is required' >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
git clone --depth 1 --branch "$WHISPER_REF" \
  https://github.com/ggml-org/whisper.cpp "$WORK/whisper"
test "$(git -C "$WORK/whisper" rev-parse HEAD)" = "$WHISPER_COMMIT"

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
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-24-14-14/$FFMPEG_ARCHIVE" \
    --output "$WORK/$FFMPEG_ARCHIVE"
fi
printf '%s  %s\n' "$FFMPEG_SHA256" "$WORK/$FFMPEG_ARCHIVE" | sha256sum --check --status
tar -xJf "$WORK/$FFMPEG_ARCHIVE" -C "$WORK" \
  "$FFMPEG_DIR/bin/ffmpeg" "$FFMPEG_DIR/LICENSE.txt"

BIN="$ROOT/build/linux-bin"
mkdir -p "$BIN/whisper" "$BIN/whisper-cpu" "$BIN/licenses"
install -m 755 "$WHISPER_VULKAN_BIN" "$BIN/whisper/whisper-cli"
install -m 755 "$WHISPER_CPU_BIN" "$BIN/whisper-cpu/whisper-cli"
install -m 644 "$WORK/whisper/LICENSE" "$BIN/whisper/LICENSE"
install -m 755 "$WORK/$FFMPEG_DIR/bin/ffmpeg" "$BIN/ffmpeg"
install -m 644 "$WORK/$FFMPEG_DIR/LICENSE.txt" "$BIN/licenses/ffmpeg.txt"

for executable in "$BIN/whisper/whisper-cli" "$BIN/whisper-cpu/whisper-cli" "$BIN/ffmpeg"; do
  file "$executable" | grep -q 'ELF 64-bit.*x86-64'
  dependencies="$(ldd "$executable")"
  if printf '%s\n' "$dependencies" | grep -q 'not found'; then
    printf '%s\n' "$dependencies" >&2
    exit 1
  fi
done
"$BIN/ffmpeg" -version >/dev/null
"$BIN/whisper/whisper-cli" --help >/dev/null 2>&1
"$BIN/whisper-cpu/whisper-cli" --help >/dev/null 2>&1
echo '[build-voice-linux] staged Vulkan Whisper, CPU fallback, and FFmpeg'
