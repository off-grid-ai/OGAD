#!/bin/sh
# The ffmpeg boundary: the decoded 16 kHz WAV it would write is the fixture recording, copied to
# the output path (its last argument).
for last in "$@"; do :; done
cp "$(dirname "$0")/../e2e-voice.wav" "$last"
