#!/usr/bin/env bash
# Start the OGAD dev app (feature/agent-browser) on DISPLAY=:99 with its own sandbox profile and a
# CDP port, for Vault setup and sandbox bench runs. Bench env vars (OFFGRID_WEBUSE_BENCH*) pass through.
#   ./run-ogad.sh            start (logs to ~/agent-sandbox/ogad/ogad.log)
set -euo pipefail
unset WAYLAND_DISPLAY XDG_CURRENT_DESKTOP DESKTOP_SESSION
export DISPLAY=:99 ELECTRON_OZONE_PLATFORM_HINT=x11
export PATH="$HOME/.nvm/versions/node/${OGAD_NODE:-v22.23.2}/bin:$PATH"
export OFFGRID_PRO=1
export OFFGRID_USER_DATA="$HOME/agent-sandbox/ogad/profile"
cd "$HOME/wednesday/off-grid-ai/desktop"
nice -n 10 taskset -c 0-7 node scripts/stage-native.mjs >/dev/null
exec nice -n 10 taskset -c 0-7 npx electron-vite dev --remoteDebuggingPort "${CDP_PORT:-9333}"
