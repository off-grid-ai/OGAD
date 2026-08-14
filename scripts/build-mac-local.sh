#!/usr/bin/env bash
#
# Local macOS test builds — produces BOTH the core (free) and pro DMGs from a
# single checkout, AD-HOC SIGNED and WITHOUT notarization or GitHub publishing, so you
# can smoke-test the packaged app before any real release.
#
#   - Developer ID discovery/notarization are skipped so there are no cert/Apple-ID
#     prompts. `mac.identity=-` makes electron-builder ad-hoc sign AFTER it mutates
#     Electron fuses; skipping that final sign produces a CODESIGNING Invalid Page
#     crash in Electron Framework. Gatekeeper still treats ad-hoc builds as unsigned.
#   - --publish never: nothing touches GitHub.
#   - Core uses OFFGRID_FORCE_CORE=1 so the pro/ submodule (present in this
#     checkout) is aliased to the stub, exactly like a real free build.
#
# Output: dist/OffGrid-core-<version>.dmg and dist/OffGrid-pro-<version>.dmg
#
# Usage:  ./scripts/build-mac-local.sh           (both)
#         ./scripts/build-mac-local.sh core       (core only)
#         ./scripts/build-mac-local.sh pro        (pro only)

set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
TARGET="${1:-both}"

export CSC_IDENTITY_AUTO_DISCOVERY=false # do not search for a Developer ID locally
export OFFGRID_ALLOW_LOCAL_ARTIFACT=1 # artifact verifier permits ad-hoc only on this unpublished path
export OFFGRID_LOCAL_PUBLISH_POLICY=never # kept in sync with both electron-builder invocations below

# Guard against the bug that broke the last release: the runtime binaries in
# resources/bin/ are stored in Git LFS. If they're still 131-byte pointer stubs,
# the packaged app ships a broken llama-server/whisper/ffmpeg and "doesn't work".
check_lfs() {
  echo "==> Checking LFS binaries are hydrated (not pointer stubs)…"
  local stubs
  stubs=$(find resources/bin -type f 2>/dev/null | while read -r f; do
    # LFS pointer files are tiny and start with the LFS spec line.
    if [ "$(wc -c < "$f")" -lt 200 ] && head -1 "$f" | grep -q "git-lfs"; then echo "$f"; fi
  done)
  if [ -n "$stubs" ]; then
    echo "!! These are LFS pointer stubs, not real binaries — run 'git lfs pull' first:"
    echo "$stubs"
    exit 1
  fi
  echo "   OK"
}

stage_native_helpers() {
  echo "==> Building native helpers through the production staging path…"
  command -v cmake >/dev/null || {
    echo "!! cmake is required to rebuild llama-server and Whisper. Install it before continuing."
    exit 1
  }
  MACOS_DEPLOYMENT_TARGET=13.0 LLAMA_REF=b9838 bash scripts/build-llama.sh
  MACOS_DEPLOYMENT_TARGET=13.0 WHISPER_REF=v1.7.4 bash scripts/build-whisper-cli.sh
  bash scripts/build-meeting-recorder.sh
  bash scripts/build-dictation-hotkey.sh
  bash scripts/build-actions-helper.sh
  mkdir -p resources/bin
  cp scripts/meeting-recorder/meeting-recorder resources/bin/meeting-recorder
  cp scripts/dictation-hotkey/dictation-hotkey resources/bin/dictation-hotkey
  cp scripts/actions-helper/actions-helper resources/bin/actions-helper
  chmod +x resources/bin/meeting-recorder resources/bin/dictation-hotkey resources/bin/actions-helper
  bash scripts/fetch-parakeet.sh
}

verify_packaged_helpers() {
  local app_dir node_arch
  node_arch="$(node -p 'process.arch')"
  case "$node_arch" in
    arm64) app_dir="dist/mac-arm64/Off Grid AI Desktop.app" ;;
    x64) app_dir="dist/mac/Off Grid AI Desktop.app" ;;
    *) echo "!! Unsupported Electron build architecture: $node_arch"; exit 1 ;;
  esac
  node scripts/probe-packaged-helpers.mjs "$app_dir"
}

build_core() {
  echo "==> Building CORE (free) macOS DMG  v$VERSION"
  OFFGRID_FORCE_CORE=1 npx electron-vite build
  npx electron-builder --mac \
    -c.mac.notarize=false \
    -c.mac.identity=- \
    -c.productName="Off Grid AI Desktop" \
    -c.appId="co.getoffgridai.desktop" \
    -c.dmg.artifactName="OffGrid-core-\${version}.dmg" \
    --publish never
  verify_packaged_helpers
}

build_pro() {
  echo "==> Building PRO macOS DMG  v$VERSION"
  npx electron-vite build
  npx electron-builder --mac \
    -c.mac.notarize=false \
    -c.mac.identity=- \
    -c.productName="Off Grid AI Desktop" \
    -c.appId="co.getoffgridai.desktop.pro" \
    -c.dmg.artifactName="OffGrid-pro-\${version}.dmg" \
    --publish never
  verify_packaged_helpers
}

check_lfs
stage_native_helpers
case "$TARGET" in
  core) build_core ;;
  pro)  build_pro ;;
  both) build_core; build_pro ;;
  *) echo "usage: $0 [core|pro|both]"; exit 1 ;;
esac

echo "==> Done. DMGs:"
ls -lh dist/*.dmg 2>/dev/null || echo "(no DMGs found in dist/)"
