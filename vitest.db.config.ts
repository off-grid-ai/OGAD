import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export const databaseProjectOptions = {
  // Vitest executes jsdom suites in Node. Keep its Vite transform on the server
  // dependency boundary so a rendered DB journey can import Node built-ins
  // without Vite trying to bundle them for a browser.
  environments: {
    client: {
      consumer: 'server' as const
    }
  },
  resolve: {
    alias: {
      '@offgrid/core': resolve(__dirname, 'src'),
      '@offgrid/pro': resolve(__dirname, 'pro'),
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    name: 'database-integration',
    include: [
      'integration-tests/*.dbtest.ts',
      'integration-tests/*.dbtest.tsx',
      'src/main/__tests__/*.dbtest.ts',
      'src/renderer/src/**/*.dbtest.tsx',
      'pro/main/__tests__/*.dbtest.ts'
    ],
    exclude: ['node_modules/**', 'out/**', 'e2e/**'],
    setupFiles: [
      'src/main/__tests__/harness/db-teardown.ts',
      'src/renderer/src/__tests__/dom-globals.setup.ts'
    ],
    fileParallelism: false as const,
    maxWorkers: 1
  }
}

// Dedicated config for core + Pro DB integration tests (*.dbtest.ts). Kept separate from the
// default command for focused diagnosis. The canonical coverage command imports these same project
// options into vitest.config.ts, so Desktop and Desktop Pro have one run and one coverage report.
export default defineConfig({
  ...databaseProjectOptions,
  test: {
    ...databaseProjectOptions.test,
    // These 266 journey tests were measuring nothing, and the default config counts on them: it
    // EXCLUDES src/main/database.ts, src/main/rag/store.ts, prompt-store and runtime-residency with the
    // note "covered by the tests in *.dbtest.ts via npm run test:db". That claim was never checked,
    // because this config had no coverage block - the one suite that loads the real native SQLite, opens
    // real databases and runs whole relaunch journeys produced no report at all.
    //
    // Deliberately scoped for the focused `test:db --coverage` diagnostic command. The canonical
    // workspace coverage run uses vitest.config.ts and one collector across product + database:
    //   include limits the focused report to its production source surface; Vitest 4 no longer uses
    //   the former `all` switch.
    //   its own reportsDirectory, so a focused diagnostic cannot overwrite the canonical report.
    // provider v8 to match the default run, so both express coverage against the same source positions.
    coverage: {
      provider: 'v8',
      // Write the report even when a test fails, so one flaky db journey cannot
      // suppress the whole report and make the new-code gate read tested files
      // as 0%. The coverage-only variant (vitest.db.coverage.config.ts) already
      // drops the tests with OPEN failures; this covers the intermittent ones.
      reportOnFailure: true,
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
        // The default unit suite owns the injected NutApi adapter. DB journeys
        // only load it through runtime composition and do not actuate native input.
        'src/main/input/actuation.ts',
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
