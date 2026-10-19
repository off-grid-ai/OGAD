#!/usr/bin/env bash
set -euo pipefail

# Build whisper.cpp's `whisper-server` from source with a PINNED macOS deployment
# target, so the bundled RESIDENT speech-to-text engine runs on the macOS versions
# our users actually have - not just whatever SDK the build machine happens to use.
#
# Why this exists: today STT is one-shot CLIs (whisper-cli, sherpa-onnx-offline)
# that RELOAD the whole model on every call (~3.3s), so live/sliding-window
# dictation thrashes and lags. whisper-server keeps ONE model resident across
# requests (loaded once, stays warm) and serves transcription over localhost HTTP,
# so interim ticks skip the reload entirely.
#
# This MIRRORS scripts/build-llama.sh exactly - same pinned deployment target,
# same three gates (minos, dependency-closure, foreign-dep), same "stage real
# files, never symlinks" rule - because the bundled engine has shipped broken to
# users three times and each failure mode has a gate here now. Run in CI before
# packaging (release.yml), NOT from the committed/LFS binary.
#
# Reuses the existing ggml whisper models the app already downloads - this builds
# ONLY the server binary, no new model download.
#
#   WHISPER_REF=v1.9.5 MACOS_DEPLOYMENT_TARGET=13.0 scripts/build-whisper.sh

WHISPER_REF="${WHISPER_REF:-v1.9.5}"                  # whisper.cpp tag with examples/server
TARGET="${MACOS_DEPLOYMENT_TARGET:-13.0}"             # runs on macOS 13+
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/resources/bin/whisper-server"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "[build-whisper] ref=$WHISPER_REF target=$TARGET"
git clone --depth 1 --branch "$WHISPER_REF" https://github.com/ggml-org/whisper.cpp "$WORK/src"
cd "$WORK/src"

# Metal on (Apple Silicon GPU), OpenMP off, and NO curl/OpenSSL: the server runs on
# 127.0.0.1 HTTP and the app manages models itself, so we don't need TLS - and linking
# Homebrew's OpenSSL would bake in an absolute /opt/homebrew path that doesn't exist on
# users' Macs. WHISPER_BUILD_SERVER=ON builds the examples/server target.
cmake -B build -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_DEPLOYMENT_TARGET="$TARGET" \
  -DCMAKE_OSX_ARCHITECTURES="arm64;x86_64" -DGGML_NATIVE=OFF \
  -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON \
  -DGGML_OPENMP=OFF \
  -DWHISPER_BUILD_SERVER=ON \
  -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
  -DCMAKE_DISABLE_FIND_PACKAGE_OpenSSL=ON -DCMAKE_DISABLE_FIND_PACKAGE_CURL=ON
cmake --build build --config Release -j"$(sysctl -n hw.ncpu)" --target whisper-server

BIN="$(find build -name whisper-server -type f -perm -111 | head -1)"
[ -n "$BIN" ] || { echo "[build-whisper] FATAL: whisper-server not produced"; exit 1; }

# Gate: fail the build if the binary targets a newer macOS than we asked for.
# (A binary with minos > target silently refuses to launch on older macOS - the
# exact "Chat model Down, no reason" class of failure that shipped in the past.)
MINOS="$(otool -l "$BIN" | awk '/LC_BUILD_VERSION/{f=1} f&&/minos/{print $2; exit}')"
echo "[build-whisper] built whisper-server minos=$MINOS (want <= $TARGET)"
if [ "${MINOS%%.*}" -gt "${TARGET%%.*}" ]; then
  echo "[build-whisper] FATAL: minos $MINOS exceeds target $TARGET - would break older macOS"; exit 1
fi

# Stage the single engine: the server + every shared lib it links, co-located.
# (whisper-server.ts spawns with DYLD_LIBRARY_PATH=<this dir>, so co-location is enough.)
rm -rf "$DEST"; mkdir -p "$DEST"
cp "$BIN" "$DEST/"
# Copy ONLY the engine's own shared libs. Two non-obvious rules, both learned the
# hard way on the llama engine (see build-llama.sh):
#  - NO -type f: the names the binary links (libggml.0.dylib) are SYMLINKS to the
#    versioned files; -type f would skip them and the bundle would miss the exact
#    @rpath names -> "Library not loaded" for every user.
#  - cp (follows symlinks) -> REAL copies of every name, not symlinks. Real files
#    are bulletproof through electron-builder packaging + codesigning; symlinks
#    inside a signed .app are a "should work" we don't need to gamble on.
find build \( -name 'libwhisper*.dylib' -o -name 'libggml*.dylib' \) -exec cp -f {} "$DEST/" \;
chmod +x "$DEST/whisper-server"
echo "[build-whisper] staged into $DEST:"; ls -1 "$DEST"

# Gate: the engine + its dylibs must link ONLY @rpath (our co-located libs) and
# system frameworks. Any /opt/homebrew or /usr/local path is a build-host leak
# that won't exist on a user's Mac (e.g. brew OpenSSL) -> fail the build now.
echo "[build-whisper] dependency audit:"; otool -L "$DEST/whisper-server" | sed -n '2,30p'
FOREIGN="$(for f in "$DEST"/whisper-server "$DEST"/*.dylib; do otool -L "$f" 2>/dev/null | tail -n +2; done | grep -E '/opt/homebrew|/usr/local' || true)"
if [ -n "$FOREIGN" ]; then
  echo "[build-whisper] FATAL: engine links non-system libs that won't exist on users' Macs:"; echo "$FOREIGN"; exit 1
fi

# Gate: EVERY @rpath dependency the binary/dylibs link must actually be present in
# DEST - by the EXACT name (e.g. libggml.0.dylib, not just libggml.0.15.3.dylib).
# This is the one that catches "staged the versioned file but dropped the .0
# symlink" -> "Library not loaded" for every user. Resolve symlinks with -e.
MISSING=""
for f in "$DEST"/whisper-server "$DEST"/*.dylib; do
  while IFS= read -r dep; do
    name="${dep#@rpath/}"
    [ -e "$DEST/$name" ] || MISSING="$MISSING $name"
  done < <(otool -L "$f" 2>/dev/null | awk '/@rpath\//{print $1}')
done
MISSING="$(echo "$MISSING" | tr ' ' '\n' | sort -u | tr '\n' ' ' | sed 's/^ *//')"
if [ -n "$MISSING" ]; then
  echo "[build-whisper] FATAL: engine references @rpath libs NOT bundled: $MISSING"; exit 1
fi

echo "[build-whisper] done - resident STT engine, minos=$MINOS, no foreign deps, all @rpath libs present"

# release.yml hook (mirrors the "Build llama-server" step; add BEFORE electron-builder
# signs+notarizes so the resident STT engine ships correct by construction):
#
#   - name: Build whisper-server (resident STT, pinned deployment target)
#     run: |
#       command -v cmake >/dev/null || brew install cmake
#       MACOS_DEPLOYMENT_TARGET=13.0 WHISPER_REF=v1.7.4 bash scripts/build-whisper.sh
#       otool -l resources/bin/whisper-server/whisper-server | awk '/LC_BUILD_VERSION/{f=1} f&&/minos/{print "[ci] resident STT engine minos="$2; exit}'
