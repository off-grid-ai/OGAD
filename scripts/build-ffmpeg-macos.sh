#!/usr/bin/env bash
# Builds the macOS ffmpeg the app ships (resources/bin/ffmpeg): a universal (arm64 + x86_64), static,
# LGPL build for macOS 13+, from pinned FFmpeg and libopus sources. It replaces a third-party binary of
# unknown provenance. The app uses ffmpeg to decode audio to 16 kHz WAV, sample video frames to JPEG,
# and remux or transcode meeting recordings (Opus in WebM, AAC in MP4, VideoToolbox H.264).
#   scripts/build-ffmpeg-macos.sh [work-dir]
set -euo pipefail
FFMPEG_REF="${FFMPEG_REF:-n9.0.2}"
OPUS_REF="${OPUS_REF:-v1.6.1}"
TARGET="${MACOS_DEPLOYMENT_TARGET:-13.0}"
# A dedicated folder under the given work dir: only it is wiped, never the caller's other files.
WORK="${1:-${TMPDIR:-/tmp}}/offgrid-ffmpeg-build"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${OFFGRID_FFMPEG_OUT:-$ROOT/resources/bin}"
JOBS="$(sysctl -n hw.ncpu)"

rm -rf "$WORK"
mkdir -p "$WORK"
git clone --quiet --depth 1 --branch "$FFMPEG_REF" https://github.com/FFmpeg/FFmpeg "$WORK/ffmpeg"
git clone --quiet --depth 1 --branch "$OPUS_REF" https://github.com/xiph/opus "$WORK/opus"

for arch in arm64 x86_64; do
  prefix="$WORK/prefix-$arch"
  cmake -S "$WORK/opus" -B "$WORK/opus-$arch" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_OSX_ARCHITECTURES="$arch" \
    -DCMAKE_OSX_DEPLOYMENT_TARGET="$TARGET" \
    -DCMAKE_INSTALL_PREFIX="$prefix" \
    -DBUILD_SHARED_LIBS=OFF -DOPUS_BUILD_PROGRAMS=OFF -DOPUS_BUILD_TESTING=OFF
  cmake --build "$WORK/opus-$arch" -j "$JOBS" --target install

  # FFmpeg finds libopus through pkg-config. A shim answers for opus alone, so the build needs no
  # pkg-config on the host and cannot pick up a Homebrew library by accident.
  shim="$WORK/pkg-config-$arch"
  cat > "$shim" <<SHIM
#!/usr/bin/env bash
case " \$* " in
  *" --version "*) echo 0.29.2 ;;
  *" opus"*) case " \$* " in
      *" --modversion "*) echo "${OPUS_REF#v}" ;;
      *" --cflags "*) echo "-I$prefix/include/opus" ;;
      *" --libs "*) echo "-L$prefix/lib -lopus" ;;
    esac ;;
  *) exit 1 ;;
esac
SHIM
  chmod +x "$shim"

  # x86asm needs nasm on the build host; the generic C paths are enough for decode and remux.
  asm=()
  [ "$arch" = x86_64 ] && asm=(--disable-x86asm)
  mkdir -p "$WORK/ffmpeg-$arch"
  (
    cd "$WORK/ffmpeg-$arch"
    "$WORK/ffmpeg/configure" \
      --prefix="$prefix" \
      --arch="$arch" --target-os=darwin --enable-cross-compile \
      --cc="clang -arch $arch" --cxx="clang++ -arch $arch" \
      --extra-cflags="-mmacosx-version-min=$TARGET -I$prefix/include" \
      --extra-ldflags="-mmacosx-version-min=$TARGET -L$prefix/lib" \
      --pkg-config="$shim" \
      --disable-autodetect --disable-debug --disable-doc \
      --disable-shared --enable-static \
      --disable-ffplay --disable-ffprobe \
      --enable-zlib --enable-videotoolbox --enable-audiotoolbox \
      --enable-libopus \
      ${asm[@]+"${asm[@]}"}
    make -j "$JOBS" ffmpeg
  )
done

TMP_OUT="$OUT/.ffmpeg.tmp.$$"
lipo -create "$WORK/ffmpeg-arm64/ffmpeg" "$WORK/ffmpeg-x86_64/ffmpeg" -output "$TMP_OUT"
codesign --force --sign - "$TMP_OUT"
# Replace by rename so a running app never sees a half-written binary.
mv -f "$TMP_OUT" "$OUT/ffmpeg"
echo "Built FFmpeg $FFMPEG_REF (libopus $OPUS_REF) into $OUT/ffmpeg"
lipo -info "$OUT/ffmpeg"
"$OUT/ffmpeg" -hide_banner -version | head -1
