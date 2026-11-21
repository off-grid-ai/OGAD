import { defineConfig } from '@playwright/test'

// The nightly performance journeys (perf/e2e). Separate from e2e/ so the PR suite never runs them:
// they launch the app many times and sit idle on purpose. One worker, no retries: a retry would
// hide exactly the slow run this exists to catch.
export default defineConfig({
  testDir: './e2e',
  // npm run perf:leaks sets PERF_SUITE=leaks for the memlab heap snapshots.
  testMatch: process.env.PERF_SUITE === 'leaks' ? '*.memlab.ts' : '*.perf.ts',
  timeout: 300_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list'
})
