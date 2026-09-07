#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWIFT_BIN="swiftc"
ENTRY="$ROOT_DIR/text-extractor/main.swift"
CORE="$ROOT_DIR/text-extractor.swift"
COMMON="$ROOT_DIR/text-extractor/common.swift"
CLASSIFIERS="$ROOT_DIR/text-extractor/classifiers.swift"
CLAUDE="$ROOT_DIR/text-extractor/claude.swift"
GENERIC="$ROOT_DIR/text-extractor/generic.swift"
CHATGPT="$ROOT_DIR/text-extractor/chatgpt.swift"
GEMINI="$ROOT_DIR/text-extractor/gemini.swift"
ELEMENTS="$ROOT_DIR/text-extractor/elements.swift"

OUT="/tmp/your-memories-text-extractor"

"$SWIFT_BIN" -emit-executable "$ENTRY" "$CORE" "$COMMON" "$CLASSIFIERS" "$CLAUDE" "$GENERIC" "$CHATGPT" "$GEMINI" "$ELEMENTS" -o "$OUT"
exec "$OUT" "$@"
