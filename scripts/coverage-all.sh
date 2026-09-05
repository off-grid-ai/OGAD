#!/usr/bin/env bash
# Every suite's coverage, in one number, over the code this branch ADDS.
#
# Desktop has several test projects. The canonical coverage command runs the product and database
# projects in one Vitest process, so core and Pro contribute to one instrumented report:
#
#   1. product-integration  (npm test)          unit + integration, jsdom + node
#   2. the DB journeys                          real native SQLite, whole relaunch journeys, ABI-swapped
#   3. the heavy projects    (npm run test:heavy) model-port + packaging; some self-skip without real engines
#   4. the e2e tour          (npm run test:e2e)  the built Electron app, driven by Playwright
#
# This runs 1 and 2 together, folds in 4 if a report is present, and reports the four metrics over the added
# lines. 3 is not included by default: three of its specs need engine binaries and real model files that a dev
# machine usually lacks, and a suite that cannot run must not silently lower a number.
#
# The e2e report is passed as --coarse. It is remapped from the bundle rather than instrumented from source, so
# its statement map is whole-file - blank lines included - and it must never set a denominator. It contributes
# covered lines only, which is all it can honestly contribute.
#
#   ./scripts/coverage-all.sh                        both local suites
#   ./scripts/coverage-all.sh --with-e2e             also capture e2e locally (needs a display)
#   E2E_COVERAGE_REPORT=path ./scripts/coverage-all.sh   fold in a report from CI's e2e-coverage artifact
#   ./scripts/coverage-all.sh --print-gate           print the coverage floor flags and exit
set -uo pipefail

cd "$(dirname "$0")/.."
MERGE="../shared/scripts/new-code-coverage.mjs"

# The four floor percentages are owned by coverage-gate.json alone — the same file vitest.config.ts
# reads for its `thresholds`. Deriving the merged new-code run's flags from it is what makes the two
# gates ONE gate: raising or lowering the floor is a one-file edit that both runners pick up, and
# neither can drift below the other. `--print-gate` prints the derived flags and exits, so a test can
# assert this script and vitest agree without running a suite.
if ! GATE_FLAGS="$(node -e 'const gate = require(process.argv[1]); process.stdout.write(Object.entries(gate).map(([metric, min]) => `--min-${metric}=${min}`).join(" "))' "$PWD/coverage-gate.json" 2>/dev/null)"; then
  echo "coverage-gate.json is missing or unreadable - refusing to run without the coverage floor." >&2
  exit 1
fi

if [ "${1:-}" = "--print-gate" ]; then
  echo "$GATE_FLAGS"
  exit 0
fi

echo "▶ Desktop + Desktop Pro (product + database journeys)…"
rm -rf coverage
OFFGRID_AGGREGATE_COVERAGE=1 npm run test:coverage -- \
  --silent --reporter=verbose --color 2>&1 \
  | tee /tmp/coverage-all-desktop.log
DESKTOP_STATUS=${PIPESTATUS[0]}

if [ "${1:-}" = "--with-e2e" ]; then
  echo "▶ e2e tour (built app, needs a display)…"
  rm -rf coverage-e2e-raw coverage-e2e
  OFFGRID_E2E_COVERAGE="$PWD/coverage-e2e-raw" npm run test:e2e 2>&1 \
    | tee /tmp/coverage-all-e2e.log
  if [ -n "$(ls -A coverage-e2e-raw 2>/dev/null)" ]; then
    ../shared/node_modules/.bin/c8 report --temp-directory=coverage-e2e-raw --reporter=json \
      --report-dir=coverage-e2e --all=false >/dev/null 2>&1
  fi
fi

REPORTS=()
[ -f coverage/coverage-final.json ] && REPORTS+=("coverage/coverage-final.json")

COARSE=""
E2E_REPORT="${E2E_COVERAGE_REPORT:-coverage-e2e/coverage-final.json}"
[ -f "$E2E_REPORT" ] && COARSE="--coarse=$E2E_REPORT"

if [ ${#REPORTS[@]} -eq 0 ]; then
  echo "No coverage report was produced. A failing test suppresses vitest's report entirely -"
  echo "see /tmp/coverage-all-product.log and /tmp/coverage-all-db.log."
  exit 1
fi

echo
E2E_NOTE="without the e2e tour"
[ -n "$COARSE" ] && E2E_NOTE="including the e2e tour"
echo "▶ new-code coverage from ${#REPORTS[@]} source-instrumented report(s), $E2E_NOTE:"
node "$MERGE" . "${REPORTS[@]}" $COARSE $GATE_FLAGS
DESKTOP_COVERAGE_STATUS=$?

if [ -z "$COARSE" ]; then
  echo
  echo "note: no e2e report folded in. Run with --with-e2e, or download CI's e2e-coverage artifact and pass"
  echo "      E2E_COVERAGE_REPORT=<path>/coverage-final.json - without it, code only the e2e tour reaches"
  echo "      (Electron bootstrap, IPC registration, rendered screens) counts as uncovered."
fi

# The suites' own exit codes are surfaced, so a green number from a red suite is impossible to mistake.
[ $DESKTOP_STATUS -eq 0 ] || echo "warning: Desktop + Desktop Pro exited $DESKTOP_STATUS"

if [ $DESKTOP_STATUS -ne 0 ] || \
  [ $DESKTOP_COVERAGE_STATUS -ne 0 ]; then
  exit 1
fi
