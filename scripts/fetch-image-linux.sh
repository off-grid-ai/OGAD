#!/usr/bin/env bash
set -euo pipefail

# Build stable-diffusion.cpp (Vulkan, with the CPU backend) from the pinned source and our patches.
# Upstream's Linux builds moved to Ubuntu 26.04 and need glibc 2.43, so we build on 24.04 instead.
# The CPU backend keeps image generation available without a working GPU driver.
ROOT="${OFFGRID_BUILD_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo '[fetch-image-linux] Linux x64 is required' >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
node "$ROOT/scripts/prepare-image-runtime.mjs" "$WORK/src"
cmake -S "$WORK/src" -B "$WORK/build" -DCMAKE_BUILD_TYPE=Release \
  -DSD_VULKAN=ON -DSD_BUILD_EXAMPLES=ON -DSD_SERVER_BUILD_FRONTEND=OFF \
  -DSD_BUILD_SHARED_LIBS=OFF -DSD_BUILD_SHARED_GGML_LIB=OFF -DGGML_NATIVE=OFF
cmake --build "$WORK/build" --target sd-cli sd-server --parallel 4
mkdir -p "$WORK/sd"
install -m 755 "$WORK/build/bin/sd-cli" "$WORK/build/bin/sd-server" "$WORK/sd/"
install -m 644 "$WORK/src/LICENSE" "$WORK/sd/LICENSE"
help="$("$WORK/sd/sd-cli" --help 2>&1)"
grep -q -- '--decode-preview-path' <<< "$help"
test -x "$WORK/sd/sd-cli"
test -x "$WORK/sd/sd-server"

DEST="$ROOT/build/linux-bin/sd"
mkdir -p "$DEST" "$ROOT/build/linux-bin/licenses"
cp -a "$WORK/sd/." "$DEST/"
# AppImage cannot depend on distribution package installs for these loaders.
# The host Vulkan ICD still supplies the actual GPU driver.
for library in libgomp.so.1 libvulkan.so.1; do
  source="$(ldconfig -p | awk -v name="$library" '$1 == name && /x86-64/ { print $NF; exit }')"
  test -n "$source"
  install -m 755 "$(readlink -f "$source")" "$DEST/$library"
done
for package in libgomp1 libvulkan1; do
  install -m 644 "/usr/share/doc/$package/copyright" \
    "$ROOT/build/linux-bin/licenses/$package.txt"
done

for binary in sd-cli sd-server; do
  file "$DEST/$binary" | grep -q 'ELF 64-bit.*x86-64'
  dependencies="$(LD_LIBRARY_PATH="$DEST" ldd "$DEST/$binary")"
  if printf '%s\n' "$dependencies" | grep -q 'not found'; then
    printf '%s\n' "$dependencies" >&2
    exit 1
  fi
  LD_LIBRARY_PATH="$DEST" "$DEST/$binary" --help >/dev/null 2>&1
done
echo '[fetch-image-linux] staged sd-cli and sd-server'
