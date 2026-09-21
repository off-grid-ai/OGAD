#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain Node CLI */
import fs from 'node:fs'
import path from 'node:path'
import { replayFixture } from './computer-use-replay.mjs'

function percentile(values, fraction) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

const files = process.argv.slice(2)
if (!files.length) {
  throw new Error('Usage: node scripts/computer-use-benchmark.mjs <fixture.json> [...]')
}
const results = files.map((file) =>
  replayFixture(JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')))
)
const recalls = results.map((result) => result.targetRecall).filter((value) => value !== null)
const decisions = results.map((result) => result.decisionCorrect).filter((value) => value !== null)
const replayTimes = results.map((result) => result.timings.replayMs)
const named = results.flatMap((result) =>
  Object.values(result.timings).filter((value) => typeof value === 'number')
)
const total = results.reduce(
  (sum, result) =>
    sum +
    (typeof result.timings.totalMs === 'number' ? result.timings.totalMs : result.timings.replayMs),
  0
)
const namedTotal = named.reduce((sum, value) => sum + value, 0)

process.stdout.write(
  `${JSON.stringify(
    {
      fixtures: results.length,
      targetRecall: recalls.length
        ? recalls.reduce((sum, value) => sum + value, 0) / recalls.length
        : null,
      decisionAccuracy: decisions.length
        ? decisions.reduce((sum, value) => sum + value, 0) / decisions.length
        : null,
      warmReplayMedianMs: percentile(replayTimes, 0.5),
      warmReplayP95Ms: percentile(replayTimes, 0.95),
      namedTimingCoverage: total > 0 ? Math.min(1, namedTotal / total) : null,
      actuations: 0
    },
    null,
    2
  )}\n`
)
