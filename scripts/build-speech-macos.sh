#!/usr/bin/env bash
set -euo pipefail

# Build the ExecuTorch speech runtime (../executorch-speech/native/bin/executorch-speech) for
# macOS 13 from the checkout beside this one. The release job runs this and caches the result on
# the speech commit and on this script, so a change here rebuilds it.

ROOT="${OFFGRID_BUILD_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
SPEECH="${OFFGRID_SPEECH_ROOT:-$ROOT/../executorch-speech}"
TARGET="${MACOS_DEPLOYMENT_TARGET:-13.0}"

npm --prefix "$SPEECH" ci
# Use the Kev runtime's Python and its existing torchgen, YAML, and Jinja dependencies. CI passes the
# pinned pack it unpacked (resources/kev-runtime-packs.json); a local build uses the bundled copy.
speech_python="${OFFGRID_SPEECH_PYTHON:-$ROOT/resources/bin/kev-runtime/python/bin/python3}"
"$speech_python" -c 'import torchgen, yaml, jinja2'
cmake -S "$SPEECH/native" -B "$SPEECH/native/build" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_DEPLOYMENT_TARGET="$TARGET" \
  -DFLATCC_ALLOW_WERROR=OFF -DPYTHON_EXECUTABLE="$speech_python"
cmake --build "$SPEECH/native/build" --config Release --parallel 4 \
  --target executorch-speech
