#!/usr/bin/env bash
# Keep the Mac generating: run after run, each copied to the server when it ends.
#   bash scripts/action-data/mac-loop.sh <first-run-number> <last-run-number>
cd "$(dirname "$0")/../.."
export CHROME_PATH="$HOME/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
# The training server comes from the environment: OGAD_POD_HOST, OGAD_POD_PORT, OGAD_POD_KEY.
POD=(ssh -o BatchMode=yes -o ConnectTimeout=20 -p "$OGAD_POD_PORT" -i "$OGAD_POD_KEY" "$OGAD_POD_HOST")
for n in $(seq "$1" "$2"); do
  run="run$n-mac"
  node scripts/action-data/run.mjs --workers 7 --episodes 500 --seed "$run" --family ${MIX:-shop:2,mail:2,feed:2,form:1,list:1} --out "outputs/action-data/$run" > "outputs/action-data/$run.log" 2>&1
  (cd outputs/action-data && tar -cf - "$run" | "${POD[@]}" "tar --no-same-owner -xf - -C /workspace/action-data && touch /workspace/action-data/$run/.copied") &
done
wait
