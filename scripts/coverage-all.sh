#!/usr/bin/env bash
# Every suite's coverage, in one number, over the code this branch ADDS.
#
# Desktop runs its tests in four places, and until now each reported alone - so any file covered by one suite
# read as 0% in the others' reports, and no single figure described the app:
#
#   1. product-integration  (npm test)          unit + integration, jsdom + node
#   2. the DB journeys       (npm run test:db)   real native SQLite, whole relaunch journeys, ABI-swapped
#   3. the heavy projects    (npm run test:heavy) model-port + packaging; some self-skip without real engines
#   4. the e2e tour          (npm run test:e2e)  the built Electron app, driven by Playwright
#
# This runs 1 and 2 locally, folds in 4 if a report is present, and reports the four metrics over the added
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
set -uo pipefail

cd "$(dirname "$0")/.."
MERGE="../shared/scripts/new-code-coverage.mjs"

echo "▶ product-integration (unit + integration)…"
rm -rf coverage
npm run test:coverage >/tmp/coverage-all-product.log 2>&1
PRODUCT_STATUS=$?
grep -E "^ +Tests " /tmp/coverage-all-product.log | tail -1

echo "▶ DB journeys (real SQLite)…"
rm -rf coverage-db
OFFGRID_DB_VITEST_CONFIG=vitest.db.coverage.config.ts npm run test:db -- --coverage \
  >/tmp/coverage-all-db.log 2>&1
DB_STATUS=$?
grep -E "^ +Tests " /tmp/coverage-all-db.log | tail -1

if [ "${1:-}" = "--with-e2e" ]; then
  echo "▶ e2e tour (built app, needs a display)…"
  rm -rf coverage-e2e-raw coverage-e2e
  OFFGRID_E2E_COVERAGE="$PWD/coverage-e2e-raw" npm run test:e2e >/tmp/coverage-all-e2e.log 2>&1
  grep -E "passed|failed" /tmp/coverage-all-e2e.log | tail -1
  if [ -n "$(ls -A coverage-e2e-raw 2>/dev/null)" ]; then
    ../shared/node_modules/.bin/c8 report --temp-directory=coverage-e2e-raw --reporter=json \
      --report-dir=coverage-e2e --all=false >/dev/null 2>&1
  fi
fi

REPORTS=()
[ -f coverage/coverage-final.json ] && REPORTS+=("coverage/coverage-final.json")
[ -f coverage-db/coverage-final.json ] && REPORTS+=("coverage-db/coverage-final.json")

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
node "$MERGE" . "${REPORTS[@]}" $COARSE
echo
node "$MERGE" ./pro "${REPORTS[@]}" $COARSE 2>/dev/null || true

if [ -z "$COARSE" ]; then
  echo
  echo "note: no e2e report folded in. Run with --with-e2e, or download CI's e2e-coverage artifact and pass"
  echo "      E2E_COVERAGE_REPORT=<path>/coverage-final.json - without it, code only the e2e tour reaches"
  echo "      (Electron bootstrap, IPC registration, rendered screens) counts as uncovered."
fi

# The suites' own exit codes are surfaced, so a green number from a red suite is impossible to mistake.
[ $PRODUCT_STATUS -eq 0 ] || echo "warning: product-integration exited $PRODUCT_STATUS"
[ $DB_STATUS -eq 0 ] || echo "warning: DB journeys exited $DB_STATUS"
