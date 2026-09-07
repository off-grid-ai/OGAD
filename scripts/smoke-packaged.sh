#!/usr/bin/env bash
# PACKAGED smoke gate - the missing link that lets packaged-only bugs ship to users.
#
# tsc + unit tests + `npm run dev` ALL pass while the ASSEMBLED .app is broken: an
# app.getAppPath()/asar lookup, a spawn cwd pointing inside the asar, a bundled asset the
# code can't find at its packaged path. Two shipped to every user undetected - TTS
# `spawn ENOTDIR` (asar-file cwd) and a blank menu-bar (icon.png resolved into the asar) -
# on top of 3 prior engine failures. None of the pre-existing gates run the REAL bundle.
#
# This launches the built .app on a throwaway profile and asserts (a) the bundled assets
# are where the code looks and (b) every engine actually works end-to-end over the gateway.
# The TTS runtime probe also transitively proves resourceFile() resolves the packaged
# Resources dir - the exact mechanism the tray icon depends on. Exits non-zero on any
# failure, so it drops straight into release.yml before signing.
#
#   npm run build:unpack     # or point at a signed build with APP=...
#   npm run smoke:packaged
#
# Env: APP=<path/to/.app> (default: dist/mac-arm64/*.app)
#      OFFGRID_MODELS=<dir> (default: the real userData models dir, if present)
#      SMOKE_IMAGE=1 to include image generation (slow; needs an image model)
set -uo pipefail
cd "$(dirname "$0")/.."

GW="http://127.0.0.1:7878"
FAILED=0
ok()   { echo "  ok: $1"; }
bad()  { echo "  FAIL: $1"; FAILED=1; }

# --- locate the built app -----------------------------------------------------
APP="${APP:-$(ls -d dist/mac-arm64/*.app 2>/dev/null | head -1)}"
if [ -z "${APP:-}" ] || [ ! -d "$APP" ]; then
  echo "[packaged-smoke] no .app found - build one first (npm run build:unpack) or pass APP=<path>"; exit 2
fi
RES="$APP/Contents/Resources"
BIN="$APP/Contents/MacOS/$(basename "$APP" .app)"
echo "[packaged-smoke] app = $APP"

# --- the port must be free (a running instance would make the bundle exit on the ------
#     single-instance lock and we'd test nothing) --------------------------------------
if [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 "$GW/v1/models" 2>/dev/null)" = "200" ]; then
  echo "[packaged-smoke] FAIL: something is already serving $GW - quit the running app first"; exit 2
fi

# --- static packaging assertions (catch missing/mislocated bundled assets) ------------
echo "[packaged-smoke] static bundle assertions"
[ -f "$RES/icon.png" ]                 && ok "icon.png unpacked in Resources (menu-bar icon)" || bad "icon.png MISSING from Resources"
[ -x "$RES/bin/executorch-speech" ]    && ok "ExecuTorch speech runtime in Resources" || bad "ExecuTorch speech runtime MISSING from Resources"
[ "$FAILED" = 0 ] || { echo "[packaged-smoke] static assertions failed - not launching"; exit 1; }
node scripts/probe-packaged-helpers.mjs "$APP" \
  && ok "packaged native helpers execute and resolve their dependencies" \
  || { bad "packaged native helper execution failed"; exit 1; }
node scripts/probe-packaged-tts.mjs "$APP" \
  && ok "packaged ExecuTorch speech runtime starts" \
  || { bad "packaged ExecuTorch speech runtime cannot start"; exit 1; }

# --- launch the bundle (PRO=0: no screen capture) -------------------------------------
# Use the given profile if set, else the real userData profile - it has a selected model,
# which chat/embeddings need. A blank profile has models on disk but none ACTIVE, so those
# probes would report "no models"; TTS (kokoro) is model-independent and works regardless.
# CI note: seed OFFGRID_USER_DATA with an active model to exercise the chat probes there.
TMPDIR_LOG="$(mktemp -d -t ogad-smoke)"
APPLOG="$TMPDIR_LOG/app.log"
# OFFGRID_USER_DATA is inherited from the caller's env if set (else the app uses the real
# userData profile, which has an active model for the chat probes). PRO=0 = no screen capture.
OFFGRID_PRO=0 "$BIN" >"$APPLOG" 2>&1 &
LAUNCH_PID=$!
cleanup() { kill "$LAUNCH_PID" 2>/dev/null; pkill -f "$APP/Contents/MacOS/" 2>/dev/null; rm -rf "$TMPDIR_LOG"; }
trap cleanup EXIT

echo "[packaged-smoke] waiting for the gateway (model load can take ~30s)…"
UP=0
for _ in $(seq 1 60); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' -m 3 "$GW/v1/models" 2>/dev/null)" = "200" ]; then UP=1; break; fi
  sleep 2
done
if [ "$UP" != 1 ]; then
  echo "[packaged-smoke] FAIL: packaged app never brought up the gateway"; echo "--- app log tail ---"; tail -30 "$APPLOG"; exit 1
fi
ok "packaged app booted + gateway up"

# Model readiness: /v1/models returns 200 before llama-server finishes loading the model
# into memory, so a chat probe fired now returns an error, not a queued wait. Poll a minimal
# chat until it actually yields content before running the probe suite.
echo "[packaged-smoke] waiting for the chat model to finish loading…"
READY=0
for _ in $(seq 1 45); do
  R=$(curl -s -m 30 "$GW/v1/chat/completions" -H 'Content-Type: application/json' \
    -d '{"messages":[{"role":"user","content":"Reply with: ok"}],"max_tokens":8,"stream":false}' 2>/dev/null)
  if echo "$R" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const c=JSON.parse(s).choices;process.exit(c&&c[0]&&c[0].message&&typeof c[0].message.content==="string"?0:1)}catch{process.exit(1)}})'; then READY=1; break; fi
  sleep 2
done
[ "$READY" = 1 ] && ok "chat model loaded" || { echo "[packaged-smoke] FAIL: chat model never became ready"; tail -20 "$APPLOG"; exit 1; }

# --- runtime engine assertions (chat/stream/embeddings/TTS/STT [+image]) ---------------
# TTS here is the load-bearing one: it exercises the exact spawn+resourceFile path that
# shipped broken, and proves the packaged Resources resolver works (which the tray relies on).
OFFGRID_GATEWAY_URL="$GW" SMOKE_IMAGE="${SMOKE_IMAGE:-0}" bash "$(dirname "$0")/smoke-api.sh" || FAILED=1

if [ "$FAILED" = 0 ]; then echo "[packaged-smoke] ALL PASSED"; else echo "[packaged-smoke] FAILURES - see above"; exit 1; fi
