#!/bin/sh

# Verify the native SQLite module with Electron's ABI after Node-based database tests. The optional
# executable argument is the external-process boundary used by the regression test.
prefix="${1:-[sqlite]}"
# The package shim resolves the installed Electron executable on macOS, Linux, and Windows.
# A platform-specific app-bundle path makes this post-test health check fail on Linux CI even
# after every database journey passes.
electron_binary="${2:-./node_modules/.bin/electron}"

if ELECTRON_RUN_AS_NODE=1 "$electron_binary" \
  -e 'new (require("better-sqlite3-multiple-ciphers"))(":memory:")' >/dev/null 2>&1; then
  echo "$prefix Electron ABI restored (app can load sqlite)."
else
  echo "$prefix WARNING: Electron cannot load sqlite - run 'npx electron-rebuild -f -w better-sqlite3-multiple-ciphers' before launching the app."
  exit 1
fi
