#!/usr/bin/env bash
# Probe the Off Grid AI Desktop Local Model Gateway (http://127.0.0.1:7878).
# Runs one cURL per endpoint and stores every response under OUT/.
set -uo pipefail

BASE="${GATEWAY_BASE:-http://127.0.0.1:7878}"
OUT="${OUT_DIR:-$(cd "$(dirname "$0")/.." && pwd)/.gateway-probe}"
mkdir -p "$OUT"
LOG="$OUT/_summary.log"
: > "$LOG"

say() { printf '%s\n' "$*" | tee -a "$LOG"; }

# run NAME METHOD PATH [curl args...]
run() {
  local name="$1" method="$2" path="$3"; shift 3
  local body="$OUT/$name.out"
  local code
  code=$(curl -s -o "$body" -w '%{http_code}' -X "$method" "$BASE$path" "$@")
  say "[$code] $method $path -> $name.out ($(wc -c < "$body" | tr -d ' ') bytes)"
}

say "=== Off Grid AI Desktop Gateway probe @ $(date) ==="
say "base=$BASE  out=$OUT"
say ""

# --- introspection ---
run health           GET  /health
run voices           GET  /v1/audio/voices
run requests-list    GET  /v1/requests
run openapi          GET  /openapi.json

# --- chat (text) ---
run chat             POST /v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Reply with exactly: pong"}],"max_tokens":16}'

# --- chat (structured / json) ---
run chat-structured  POST /v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Give me a person as JSON with name and age."}],"max_tokens":64,"response_format":{"type":"json_object"}}'

# --- embeddings ---
run embeddings       POST /v1/embeddings -H 'Content-Type: application/json' \
  -d '{"input":["text one","text two"]}'

# --- TTS (returns wav bytes) ---
run tts-wav          POST /v1/audio/speech -H 'Content-Type: application/json' \
  -d '{"input":"Hello from Off Grid.","voice":"af_heart"}'

# --- image generation (small + few steps to stay quick) ---
run image            POST /v1/images -H 'Content-Type: application/json' \
  -d '{"prompt":"a yellow rubber duck","width":256,"height":256,"steps":4}'

run image-generation POST /v1/images/generations -H 'Content-Type: application/json' \
  -d '{"prompt":"a yellow rubber duck","size":"256x256"}'

# --- MCP: tools/list ---
run mcp-tools-list   POST /mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# --- MCP: generate_text tool call ---
run mcp-generate     POST /mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"generate_text","arguments":{"prompt":"Say hi in one word."}}}'

say ""
say "=== done. responses in $OUT ==="
