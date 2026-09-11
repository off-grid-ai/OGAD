#!/usr/bin/env bash
# DB integration tests exercise the production SQLite addon against temporary databases.
# Run Vitest through Electron's embedded Node runtime so the runner and the app use the same
# native ABI. Never rebuild node_modules for the shell's Node ABI: that mutates the app runtime
# and caused recurring ABI 140/147 failures whenever tests and development overlapped.
set -euo pipefail

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
node scripts/vitest-electron-node.mjs run --config "$DB_CONFIG" --no-file-parallelism --maxWorkers=1 "$@"
