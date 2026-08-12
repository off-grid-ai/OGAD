import { defineConfig, mergeConfig } from 'vitest/config'
import dbConfig from './vitest.db.config'

// Coverage-only variant of the db suite.
//
// vitest writes NO coverage report when any test fails, so a single red test hides what the other 260
// journeys cover. This config runs the suite minus the files with open, DOCUMENTED failures, so the
// report exists while they are decided. It is not a way to look better: every exclusion is named here
// with its reason, `npm run test:db` still runs everything, and the number this produces is explicitly
// "the db journeys that pass today".
//
// Delete an entry the moment its cause is resolved.
export default mergeConfig(
  dbConfig,
  defineConfig({
    test: {
      exclude: [
        ...(dbConfig.test?.exclude ?? []),
        // Passes alone, fails when a neighbour still holds the model port: LLMService probes 8439 with an
        // HTTP /health request, so a process squatting the port without that endpoint reads as free and
        // the engine spawn then dies with EADDRINUSE. The journey is sound; the coupling is the port.
        '**/fresh-setup-first-use.integration.dbtest.ts'
      ]
    }
  })
)
