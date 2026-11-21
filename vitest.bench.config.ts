import { defineConfig } from 'vitest/config'

// Micro-benchmarks for the search and retrieval hot paths (perf/bench). Separate from the test
// projects so `npm test` never runs them; perf/bench-gate.mjs runs them and compares a baseline.
export default defineConfig({
  test: {
    include: [],
    benchmark: {
      include: ['perf/bench/**/*.bench.ts']
    }
  }
})
