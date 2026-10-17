#!/usr/bin/env bash
set -euo pipefail

# Pin the upstream Ubuntu 24.04 x64 Vulkan build. It also contains the CPU
# backend, so image generation remains available without a working GPU driver.
ROOT="${OFFGRID_BUILD_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
ARCHIVE=sd-master-8cd731e-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip
SHA256=1e82f932a678e28035d64bc9909b9c122c6ec0f92fcfd8e9ac2bea99b5619505
URL="https://github.com/leejet/stable-diffusion.cpp/releases/download/master-968-8cd731e/$ARCHIVE"

if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo '[fetch-image-linux] Linux x64 is required' >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
if [ -n "${OFFGRID_SD_ARCHIVE_CACHE_DIR:-}" ] &&
  [ -f "$OFFGRID_SD_ARCHIVE_CACHE_DIR/$ARCHIVE" ]; then
  cp "$OFFGRID_SD_ARCHIVE_CACHE_DIR/$ARCHIVE" "$WORK/$ARCHIVE"
else
  curl --fail --location --retry 3 --silent --show-error "$URL" --output "$WORK/$ARCHIVE"
fi
printf '%s  %s\n' "$SHA256" "$WORK/$ARCHIVE" | sha256sum --check --status
unzip -q "$WORK/$ARCHIVE" -d "$WORK/sd"
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
