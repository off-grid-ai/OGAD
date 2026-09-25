import dbConfig from './vitest.db.config'

// The first-use journey now awaits its owned model process on teardown, so it
// can participate in the same source-instrumented DB suite as the other journeys.
// Platform-specific exclusions remain documented in vitest.db.ci.config.ts.
export default dbConfig
