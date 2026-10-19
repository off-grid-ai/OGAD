#!/bin/sh
# The whisper-cli boundary for the voice-turn spec: it takes a few seconds, the way a real
# transcription of a short note does, so the spec can move to another chat meanwhile. Each run
# is recorded in OFFGRID_WHISPER_LOG.
[ -n "$OFFGRID_WHISPER_LOG" ] && echo "transcribe $(date +%s)" >> "$OFFGRID_WHISPER_LOG"
sleep "${OFFGRID_WHISPER_DELAY:-6}"
printf "Book a table by the river for Friday\n"
