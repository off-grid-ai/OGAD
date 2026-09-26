#!/usr/bin/env bash
set -euo pipefail

# Build the pinned sibling ExecuTorch speech runtime for Linux x64. The upstream
# React Native and Phonemis headers need these standard headers injected with
# GCC; the source remains owned by the speech repository.
ROOT="${OFFGRID_BUILD_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
SPEECH_ROOT="${OFFGRID_SPEECH_ROOT:-$ROOT/../executorch-speech}"
PYTHON="$(command -v python3)"

if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo '[build-tts-linux] Linux x64 is required' >&2
  exit 1
fi
test -f "$SPEECH_ROOT/package.json"
"$PYTHON" -c 'import torchgen, yaml, jinja2'
npm --prefix "$SPEECH_ROOT" ci
cmake -S "$SPEECH_ROOT/native" -B "$SPEECH_ROOT/native/build" \
  -DCMAKE_BUILD_TYPE=Release -DFLATCC_ALLOW_WERROR=OFF \
  -DCMAKE_CXX_FLAGS='-include cstdint -include locale -include mutex -include optional' \
  -DPYTHON_EXECUTABLE="$PYTHON"
cmake --build "$SPEECH_ROOT/native/build" --parallel "${OFFGRID_BUILD_JOBS:-4}" \
  --target executorch-speech

BIN="$SPEECH_ROOT/native/bin/executorch-speech"
test -x "$BIN"
file "$BIN" | grep -q 'ELF 64-bit.*x86-64'
dependencies="$(ldd "$BIN")"
if printf '%s\n' "$dependencies" | grep -q 'not found'; then
  printf '%s\n' "$dependencies" >&2
  exit 1
fi
"$BIN" --probe
echo '[build-tts-linux] staged ExecuTorch speech'
