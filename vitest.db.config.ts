import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

// Dedicated config for core + Pro DB integration tests (*.dbtest.ts). Kept separate from the
// default vitest run because they load the better-sqlite3 native module (see
// scripts/test-db.sh). Run via `npm run test:db`.
export default defineConfig({
  resolve: {
    alias: {
      '@offgrid/core': resolve(__dirname, 'src'),
      '@offgrid/pro': resolve(__dirname, 'pro'),
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    include: [
      'integration-tests/*.dbtest.ts',
      'integration-tests/*.dbtest.tsx',
      'src/main/__tests__/*.dbtest.ts',
      'pro/main/__tests__/*.dbtest.ts'
    ],
    exclude: ['node_modules/**', 'out/**', 'e2e/**'],
    // Every file leaves the model port free for the next one - see the harness for why that has to be
    // suite-wide rather than each file's own business.
    setupFiles: [
      'src/main/__tests__/harness/db-teardown.ts',
      // The UI journeys in this suite render real Radix components, which construct a
      // ResizeObserver in a layout effect. Inert in the node-environment files.
      'src/renderer/src/__tests__/dom-globals.setup.ts'
    ],
    // These 266 journey tests were measuring nothing, and the default config counts on them: it
    // EXCLUDES src/main/database.ts, src/main/rag/store.ts, prompt-store and runtime-residency with the
    // note "covered by the tests in *.dbtest.ts via npm run test:db". That claim was never checked,
    // because this config had no coverage block - the one suite that loads the real native SQLite, opens
    // real databases and runs whole relaunch journeys produced no report at all.
    //
    // Deliberately complementary rather than a second opinion:
    //   all: false  - only what this run actually loaded. all:true would put every logic file in the
    //                 denominator, and this suite is not trying to cover all of them; the default run
    //                 owns that denominator. Merging the two reports is what gives the whole picture,
    //                 and a file only ever contributes the totals of the report that measured it.
    //   its own reportsDirectory, so it cannot overwrite the default run's report - they are merged
    //   afterwards by shared/scripts/merge-line-coverage.mjs.
    // provider v8 to match the default run, so both express coverage against the same source positions.
    coverage: {
      provider: 'v8',
      all: false,
      include: ['src/**/*.ts', 'pro/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/*.dbtest.ts',
        '**/*.dbtest.tsx',
        '**/__tests__/**',
        '**/*.d.ts',
        '**/dist/**',
        'packages/**'
      ],
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: 'coverage-db'
    }
  }
})
