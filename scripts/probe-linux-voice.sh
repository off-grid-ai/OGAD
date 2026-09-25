#!/usr/bin/env bash
set -euo pipefail

# Exercise the packaged chat-voice path: WebM/Opus -> 16 kHz WAV -> Whisper.
# Pin both fixtures so a changed remote file cannot make the release check pass.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${1:-$ROOT/build/linux-bin}"
WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT

download_fixture() {
  local name="$1" sha="$2" url="$3"
  if [ -n "${OFFGRID_VOICE_PROBE_CACHE_DIR:-}" ] &&
    [ -f "$OFFGRID_VOICE_PROBE_CACHE_DIR/$name" ]; then
    cp "$OFFGRID_VOICE_PROBE_CACHE_DIR/$name" "$WORK/$name"
  else
    curl --fail --location --retry 3 --silent --show-error "$url" --output "$WORK/$name"
  fi
  printf '%s  %s\n' "$sha" "$WORK/$name" | sha256sum --check --status
}

download_fixture ggml-tiny.en.bin \
  921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.en.bin
download_fixture jfk.wav \
  59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e \
  https://raw.githubusercontent.com/ggml-org/whisper.cpp/8a9ad7844d6e2a10cddf4b92de4089d7ac2b14a9/samples/jfk.wav

"$BIN/ffmpeg" -hide_banner -loglevel error -y \
  -i "$WORK/jfk.wav" -c:a libopus "$WORK/mic.webm"
"$BIN/ffmpeg" -hide_banner -loglevel error -y \
  -i "$WORK/mic.webm" -vn -ar 16000 -ac 1 -f wav "$WORK/decoded.wav"
"$BIN/whisper/whisper-cli" -m "$WORK/ggml-tiny.en.bin" -f "$WORK/decoded.wav" \
  -l en -np -nt -mc 0 -sns > "$WORK/transcript.txt"
grep -qi 'ask not what your country can do for you' "$WORK/transcript.txt"
echo '[probe-linux-voice] WebM decode and local transcription passed'
