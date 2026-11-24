#!/usr/bin/env bash
# One bench run over the sandbox profiles in OGAD (dev app, sandbox profile).
#   ./bench.sh [tasks.json] [out-dir]
# Default: the sandbox partitions start signed out, so each task meets the sign-in page and the
# Vault fills it (the model sees the username and ••••••••). SIGNED_IN=1 signs every profile in
# through the Vault first (prove-profiles.mjs), so the tasks start on the signed-in site.
# Needs: ../sandbox.sh up, ./serve-cpu.sh start (or other endpoints in BENCH_MODELS), the Vault
# (vault-setup.mjs) and a finished onboarding (onboard.mjs) in this profile.
set -euo pipefail
cd "$(dirname "$0")"
TASKS="$(realpath "${1:-bench-sandbox.json}")"
OUT="$(realpath -m "${2:-results/$(date +%m%d-%H%M)}")"
CDP="${CDP_PORT:-9333}"
NODE="$HOME/.nvm/versions/node/v22.23.2/bin/node"

stop_app() {
  pkill -f "electron-vite dev --remoteDebuggingPort $CDP" || true
  pkill -f "electron . --remote-debugging-port=$CDP" || true   # an old instance keeps the profile lock
  while pgrep -f "electron . --remote-debugging-port=$CDP" >/dev/null; do sleep 1; done
}
start_app() {
  ./run-ogad.sh > "$1" 2>&1 &
  until curl -s "127.0.0.1:$CDP/json/list" | grep -q localhost:5173; do sleep 1; done
  "$NODE" vault-setup.mjs "$CDP" | grep -E '"status"|"opened"'   # unlock before the bench starts
  "$NODE" connect-mail.mjs "$CDP"   # the email connection reads the emailed sign-in codes
}

mkdir -p "$OUT"
stop_app
rm -rf profile/Partitions/sandbox-*          # signed out
# OTP=1 / OTP=0: bank + airline sign-in asks for an emailed code (or not). Unset keeps the current setting.
if [ -n "${OTP:-}" ]; then ../sandbox.sh otp "$([ "$OTP" = 1 ] && echo on || echo off)"; fi
../sandbox.sh reset >/dev/null                # clean shop/airline/bank/forms, fresh mail + cloud seed
if [ "${SIGNED_IN:-0}" = 1 ]; then
  start_app "$OUT/signin.log"
  "$NODE" prove-profiles.mjs "$CDP" > "$OUT/signin.jsonl"
  stop_app
fi
export OFFGRID_WEBUSE_BENCH="$TASKS" OFFGRID_WEBUSE_BENCH_OUT="$OUT"
LOCAL_MODELS='{"planner":{"baseUrl":"http://127.0.0.1:8471/v1","model":"planner"},"actor":{"baseUrl":"http://127.0.0.1:8472/v1","model":"actor"},"evaluator":{"baseUrl":"http://127.0.0.1:8473/v1","model":"evaluator"}}'
export OFFGRID_WEBUSE_BENCH_MODELS="${BENCH_MODELS:-$LOCAL_MODELS}"
export OFFGRID_WEBUSE_BENCH_LIMIT_MS="${LIMIT_MS:-600000}"
echo "bench -> $OUT"
start_app "$OUT/ogad.log"
until [ -s "$OUT/summary.json" ]; do sleep 10; done
cat "$OUT/summary.json"
[ "${KEEP_APP:-0}" = 1 ] || stop_app
