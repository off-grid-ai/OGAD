#!/usr/bin/env bash
set -euo pipefail

# Build llama-server from source with a PINNED macOS deployment target, so the
# bundled engine runs on the macOS versions our users actually have — not just
# whatever SDK the build machine happens to use.
#
# Why this exists: a prior release shipped a llama-server compiled on a macOS-26
# toolchain with no deployment target, so it inherited `minos 26.0` and refused
# to launch on macOS 13/14/15 → "Chat model Down" for most users. Even the
# official llama.cpp release binaries are now minos 26. The only reliable fix is
# to build it ourselves with the target pinned. Run in CI before packaging.
#
#   LLAMA_REF=b10369 MACOS_DEPLOYMENT_TARGET=13.0 scripts/build-llama.sh   (override; default is package.json offgrid.llamaRef)

# ONE owner for the version: package.json, where every other version in this repo already lives. It was
# hardcoded here AND in fetch-win-binaries.ps1 AND passed again by two callers - one fact with four homes.
# The macOS source build and the Windows binary fetch must be the same llama.cpp, or grammar and native
# tool-call handling differ between the platforms of a single release.
LLAMA_REF="${LLAMA_REF:-$(node -p "require('$(cd "$(dirname "$0")/.." && pwd)/package.json').offgrid.llamaRef")}"
TARGET="${MACOS_DEPLOYMENT_TARGET:-13.0}"             # runs on macOS 13+
ROOT="${OFFGRID_BUILD_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DEST="$ROOT/resources/bin/llama"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "[build-llama] ref=$LLAMA_REF target=$TARGET"
git clone --depth 1 --branch "$LLAMA_REF" https://github.com/ggml-org/llama.cpp "$WORK/src"
cd "$WORK/src"

# No CURL / no OpenSSL: the server runs on 127.0.0.1 HTTP and the app downloads
# models itself, so we don't need TLS — and linking Homebrew's OpenSSL would
# bake in an absolute /opt/homebrew path that doesn't exist on users' Macs.
cmake -B build -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_DEPLOYMENT_TARGET="$TARGET" \
  -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON \
  -DGGML_OPENMP=OFF \
  -DLLAMA_CURL=OFF \
  -DCMAKE_DISABLE_FIND_PACKAGE_OpenSSL=ON -DCMAKE_DISABLE_FIND_PACKAGE_CURL=ON \
  -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_TOOLS=ON
cmake --build build --config Release -j"$(sysctl -n hw.ncpu)" --target llama-server

BIN="$(find build -name llama-server -type f -perm -111 | head -1)"
[ -n "$BIN" ] || { echo "[build-llama] FATAL: llama-server not produced"; exit 1; }

# Gate: fail the build if the binary targets a newer macOS than we asked for.
MINOS="$(otool -l "$BIN" | awk '/LC_BUILD_VERSION/{f=1} f&&/minos/{print $2; exit}')"
echo "[build-llama] built llama-server minos=$MINOS (want <= $TARGET)"
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
  echo "[build-llama] FATAL: built llama-server has no LC_BUILD_VERSION minos"; exit 1
fi
if version_exceeds "$MINOS" "$TARGET"; then
  echo "[build-llama] FATAL: minos $MINOS exceeds target $TARGET — would break older macOS"; exit 1
fi

# Stage the single engine: the server + every shared lib it links, co-located.
# (llm.ts spawns with DYLD_LIBRARY_PATH=<this dir>, so co-location is enough.)
rm -rf "$DEST"; mkdir -p "$DEST"
cp "$BIN" "$DEST/"
# Copy ONLY the engine's own shared libs — never a stray host dylib (e.g. libvips).
# Two non-obvious rules, both learned the hard way:
#  - NO -type f: the names the binary links (libggml.0.dylib) are SYMLINKS to the
#    versioned files; -type f would skip them and the bundle would miss the exact
#    @rpath names → "Library not loaded" for every user.
#  - cp (follows symlinks) → REAL copies of every name, not symlinks. Real files
#    are bulletproof through electron-builder packaging + codesigning; symlinks
#    inside a signed .app are a "should work" we don't need to gamble on.
find build \( -name 'libllama*.dylib' -o -name 'libggml*.dylib' -o -name 'libmtmd*.dylib' \) -exec cp -f {} "$DEST/" \;
chmod +x "$DEST/llama-server"
echo "[build-llama] staged into $DEST:"; ls -1 "$DEST"

# Gate: the engine + its dylibs must link ONLY @rpath (our co-located libs) and
# system frameworks. Any /opt/homebrew or /usr/local path is a build-host leak
# that won't exist on a user's Mac (e.g. brew OpenSSL) → fail the build now.
echo "[build-llama] dependency audit:"; otool -L "$DEST/llama-server" | sed -n '2,30p'
FOREIGN="$(for f in "$DEST"/llama-server "$DEST"/*.dylib; do otool -L "$f" 2>/dev/null | tail -n +2; done | grep -E '/opt/homebrew|/usr/local' || true)"
if [ -n "$FOREIGN" ]; then
  echo "[build-llama] FATAL: engine links non-system libs that won't exist on users' Macs:"; echo "$FOREIGN"; exit 1
fi

# Gate: EVERY @rpath dependency the binary/dylibs link must actually be present in
# DEST — by the EXACT name (e.g. libggml.0.dylib, not just libggml.0.15.3.dylib).
# This is the one that catches "staged the versioned file but dropped the .0
# symlink" → "Library not loaded" for every user. Resolve symlinks with -e.
MISSING=""
for f in "$DEST"/llama-server "$DEST"/*.dylib; do
  while IFS= read -r dep; do
    name="${dep#@rpath/}"
    if [ ! -f "$DEST/$name" ] || [ -L "$DEST/$name" ]; then
      MISSING="$MISSING $name"
    fi
  done < <(otool -L "$f" 2>/dev/null | awk '/@rpath\//{print $1}')
done
MISSING="$(echo "$MISSING" | tr ' ' '\n' | sort -u | tr '\n' ' ' | sed 's/^ *//')"
if [ -n "$MISSING" ]; then
  echo "[build-llama] FATAL: engine references @rpath libs missing or not staged as real files: $MISSING"; exit 1
fi

echo "[build-llama] done — single engine, minos=$MINOS, no foreign deps, all @rpath libs present"
