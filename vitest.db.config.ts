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
      // Write the report even when a test fails, so one flaky db journey cannot
      // suppress the whole report and make the new-code gate read tested files
      // as 0%. The coverage-only variant (vitest.db.coverage.config.ts) already
      // drops the tests with OPEN failures; this covers the intermittent ones.
      reportOnFailure: true,
      all: false,
      include: ['src/**/*.ts', 'pro/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/*.dbtest.ts',
        '**/*.dbtest.tsx',
        '**/__tests__/**',
        '**/*.d.ts',
        '**/dist/**',
        'packages/**',
        // Owned by the DEFAULT run's report (unit-tested there): this suite only
        // LOADS them through use-runtime's import graph, and with all:false a
        // loaded-but-unmeasured file would still land in this report and halve
        // the merged denominator for code this suite never set out to cover.
        'src/main/index.ts',
        'src/main/actions/semantic-rail-win.ts',
        'src/main/tools/nativeActionToolExtension.ts',
        'src/main/tools/nativeActionToolExtension-logic.ts',
        // The browser + vision rails are UNIT-owned (browser-rail / vision-rail
        // / driver / loop / guard / parser all have their own suites). This
        // suite only LOADS them through use-runtime's import graph and never
        // exercises them, so with all:false they land here at ~0% and the
        // merge - which sums denominators per report - drags the branch/
        // function ratio for code another report already covers well. One
        // report owns each file: the unit report owns these.
        'src/main/browser/**',
        'src/main/vision/**',
        // Renderer surface (.ts + .tsx) is rendered-behaviour owned by the e2e tour +
        // targeted render tests, never by this Node SQLite journey. V8 reports transitive
        // imports even when they do not match `include`, so exclude the whole renderer +
        // pro renderer surface explicitly - a jsdom journey that merely MOUNTS a component
        // would otherwise make this report own it and gate a surface it never set out to cover.
        'src/renderer/src/**/*.ts',
        'src/renderer/src/**/*.tsx',
        'pro/renderer/**/*.ts',
        'pro/renderer/**/*.tsx'
      ],
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: 'coverage-db'
    }
  }
})
