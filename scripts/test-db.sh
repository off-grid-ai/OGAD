#!/usr/bin/env bash
# DB integration tests (core + pro *.dbtest.ts) exercise the real data layer against
# a temp SQLite DB. They need better-sqlite3-multiple-ciphers built for the TEST RUNNER's node
# ABI - but the app builds it for ELECTRON's ABI (via electron-builder install-app-deps). So:
# rebuild for node, run the tests, then ALWAYS restore Electron's build - even on failure or
# interrupt - so the Electron app is never left with a mismatched native module.
#
# Kept OUT of the default `npm test` (those files are *.dbtest.ts, not *.test.ts) precisely
# because of this ABI swap. Run it explicitly: `npm run test:db`. A CI job that runs it must
# do so in an isolated step (the rebuild mutates node_modules).
# -e: abort on any failure (e.g. `npm rebuild` failing) so we never run the tests against a stale
# ABI. The EXIT trap below still fires on abort, so Electron's build is restored either way.
set -euo pipefail

restore() {
  echo "[test:db] restoring the Electron ABI build of better-sqlite3-multiple-ciphers..."
  # electron-rebuild reliably targets the installed Electron's ABI (install-app-deps can
  # no-op from cache). Verify the app can actually load it; warn loudly if not.
  npx electron-rebuild -f -w better-sqlite3-multiple-ciphers >/dev/null 2>&1 \
    || npx electron-builder install-app-deps >/dev/null 2>&1 || true
  ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
    -e 'new (require("better-sqlite3-multiple-ciphers"))(":memory:")' >/dev/null 2>&1 \
    && echo "[test:db] Electron ABI restored (app can load sqlite)." \
    || echo "[test:db] WARNING: Electron cannot load sqlite - run 'npx electron-rebuild -f -w better-sqlite3-multiple-ciphers' before launching the app."
}
trap restore EXIT

echo "[test:db] rebuilding better-sqlite3-multiple-ciphers for node $(node -v)..."
npm rebuild better-sqlite3-multiple-ciphers >/dev/null 2>&1

echo "[test:db] running DB integration tests..."
# Native/model/UI DB journeys are intentionally serial. Parallel files compete for
# process-wide engines, Electron module state, and timing-sensitive recorder owners,
# which turns real integration coverage into suite-load flakes.
# Which config to run. Defaults to the full suite; OFFGRID_DB_VITEST_CONFIG selects the coverage
# variant (vitest.db.coverage.config.ts), which skips the files with documented open failures so a
# report gets written at all - vitest emits none when any test fails. Passing --config twice on the
# command line breaks vitest's argument parser, hence an env var rather than an extra flag.
DB_CONFIG="${OFFGRID_DB_VITEST_CONFIG:-vitest.db.config.ts}"
echo "[test:db] config: $DB_CONFIG"
npx vitest run --config "$DB_CONFIG" --no-file-parallelism --maxWorkers=1 "$@"
