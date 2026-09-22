#!/usr/bin/env bash
set -euo pipefail

# Build the one-shot whisper.cpp CLI from a pinned source revision and stage the
# executable plus its exact shared-library closure into resources/bin/whisper.
# Release CI and the local DMG build both call this script. The committed LFS
# payload is not trusted as a release input.

WHISPER_REF="${WHISPER_REF:-v1.7.4}"
TARGET="${MACOS_DEPLOYMENT_TARGET:-13.0}"
ROOT="${OFFGRID_BUILD_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DEST="$ROOT/resources/bin/whisper"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "[build-whisper-cli] ref=$WHISPER_REF target=$TARGET"
git clone --depth 1 --branch "$WHISPER_REF" https://github.com/ggml-org/whisper.cpp "$WORK/src"
cd "$WORK/src"

# Metal remains enabled for Apple Silicon. OpenMP and BLAS are explicitly off:
# auto-discovering Homebrew libomp produced a CLI that launched on the build Mac
# but could not launch on a user's clean Mac. The app owns model downloads, so
# curl and OpenSSL are unnecessary too.
cmake -B build -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_DEPLOYMENT_TARGET="$TARGET" \
  -DBUILD_SHARED_LIBS=ON \
  -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON \
  -DGGML_OPENMP=OFF -DGGML_BLAS=OFF \
  -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
  -DWHISPER_BUILD_SERVER=OFF \
  -DCMAKE_DISABLE_FIND_PACKAGE_OpenSSL=ON -DCMAKE_DISABLE_FIND_PACKAGE_CURL=ON
cmake --build build --config Release -j"$(sysctl -n hw.ncpu)" --target whisper-cli

BIN="$(find build -name whisper-cli -type f -perm -111 | head -1)"
[ -n "$BIN" ] || {
  echo "[build-whisper-cli] FATAL: whisper-cli not produced"
  exit 1
}

MINOS="$(otool -l "$BIN" | awk '/LC_BUILD_VERSION/{f=1} f&&/minos/{print $2; exit}')"
echo "[build-whisper-cli] built whisper-cli minos=$MINOS (want <= $TARGET)"
version_exceeds() {
  awk -v built="$1" -v target="$2" 'BEGIN {
    built_n = split(built, built_parts, ".")
    target_n = split(target, target_parts, ".")
    n = built_n > target_n ? built_n : target_n
    for (i = 1; i <= n; i++) {
      built_part = (i <= built_n ? built_parts[i] : 0) + 0
      target_part = (i <= target_n ? target_parts[i] : 0) + 0
      if (built_part > target_part) exit 0
      if (built_part < target_part) exit 1
    }
    exit 1
  }'
}
if [ -z "$MINOS" ]; then
  echo "[build-whisper-cli] FATAL: built whisper-cli has no LC_BUILD_VERSION minos"
  exit 1
fi
if version_exceeds "$MINOS" "$TARGET"; then
  echo "[build-whisper-cli] FATAL: minos $MINOS exceeds target $TARGET - would break older macOS"
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST"
cp "$BIN" "$DEST/"
# Do not add -type f here. The exact @rpath names are symlinks in the build tree;
# cp follows them into real files so signed app bundles never depend on symlinks.
find build \( -name 'libwhisper*.dylib' -o -name 'libggml*.dylib' \) -exec cp -f {} "$DEST/" \;
chmod +x "$DEST/whisper-cli"

# The executable and every dylib inherit build-tree LC_RPATH values from CMake.
# Apple's distribution policy rejects any one of those temporary absolute paths,
# even when dyld can find the libraries by another route. Keep the entire staged
# closure self-contained before electron-builder signs it.
for f in "$DEST"/whisper-cli "$DEST"/*.dylib; do
  while IFS= read -r rpath; do
    install_name_tool -delete_rpath "$rpath" "$f"
  done < <(otool -l "$f" | awk '/cmd LC_RPATH/{found=1; next} found && $1 == "path" {print $2; found=0}')
  install_name_tool -add_rpath @loader_path "$f"
done

BAD_RPATHS="$(for f in "$DEST"/whisper-cli "$DEST"/*.dylib; do
  otool -l "$f" | awk -v file="$f" '
    /cmd LC_RPATH/ { found=1; next }
    found && $1 == "path" {
      if ($2 != "@loader_path") print file ": " $2
      found=0
    }
  '
done)"
if [ -n "$BAD_RPATHS" ]; then
  echo "[build-whisper-cli] FATAL: engine contains runtime paths outside its bundled directory:"
  echo "$BAD_RPATHS"
  exit 1
fi

echo "[build-whisper-cli] staged into $DEST:"
ls -1 "$DEST"

echo "[build-whisper-cli] dependency audit:"
otool -L "$DEST/whisper-cli" | sed -n '2,30p'
FOREIGN="$(for f in "$DEST"/whisper-cli "$DEST"/*.dylib; do otool -L "$f" 2>/dev/null | tail -n +2; done | grep -E '/opt/homebrew|/usr/local' || true)"
if [ -n "$FOREIGN" ]; then
  echo "[build-whisper-cli] FATAL: engine links non-system libs that will not exist on users' Macs:"
  echo "$FOREIGN"
  exit 1
fi

MISSING=""
for f in "$DEST"/whisper-cli "$DEST"/*.dylib; do
  while IFS= read -r dep; do
    name="${dep#@rpath/}"
    if [ ! -f "$DEST/$name" ] || [ -L "$DEST/$name" ]; then
      MISSING="$MISSING $name"
    fi
  done < <(otool -L "$f" 2>/dev/null | awk '/@rpath\//{print $1}')
done
MISSING="$(echo "$MISSING" | tr ' ' '\n' | sort -u | tr '\n' ' ' | sed 's/^ *//')"
if [ -n "$MISSING" ]; then
  echo "[build-whisper-cli] FATAL: engine references @rpath libs missing or not staged as real files: $MISSING"
  exit 1
fi

echo "[build-whisper-cli] done - minos=$MINOS, @loader_path only, no foreign deps, all @rpath libs present"
