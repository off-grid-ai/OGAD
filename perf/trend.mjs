#!/usr/bin/env node
// Compare one nightly result with the recent runs, then add it to the trend file.
//
//   node perf/trend.mjs <results.json> <trend.jsonl>
//
// <results.json> is { date, machine, results: { group: { metric: number } } } (what the perf
// journeys and the memlab run write). The reference is the median of the last PERF_TREND_WINDOW
// (default 7) entries from the same machine, so a CI runner is compared with CI runs and a laptop
// with itself. A metric fails when it is more than PERF_TREND_TOLERANCE (default 0.2) above the
// reference AND above it by more than a floor for its unit, so noise on tiny numbers cannot fail a
// run. Every metric here is "lower is better". The result is appended either way, so the trend shows
// the regression; the exit code says whether there was one.
import fs from 'node:fs'

const [resultsFile, trendFile] = process.argv.slice(2)
if (!resultsFile || !trendFile) {
  console.error('usage: node perf/trend.mjs <results.json> <trend.jsonl>')
  process.exit(2)
}
const tolerance = Number(process.env.PERF_TREND_TOLERANCE ?? 0.2)
const window = Number(process.env.PERF_TREND_WINDOW ?? 7)

// The smallest change worth failing on, by the metric's unit.
const floorFor = (metric) => {
  if (/Ms$/.test(metric)) return 50
  if (/CpuPercent$/.test(metric)) return 2
  if (/MB$/.test(metric)) return 20
  if (/^domNodes$/.test(metric)) return 300
  if (/Bytes$/.test(metric)) return 1_048_576
  return 5 // counts
}

const run = JSON.parse(fs.readFileSync(resultsFile, 'utf8'))
const flat = {}
for (const [group, metrics] of Object.entries(run.results)) {
  for (const [metric, value] of Object.entries(metrics)) flat[`${group}.${metric}`] = value
}

const history = fs.existsSync(trendFile)
  ? fs
      .readFileSync(trendFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.machine === run.machine)
      .slice(-window)
  : []

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

let regressions = 0
if (!history.length) {
  console.log(`No earlier runs on "${run.machine}": recording this one as the start of the trend.`)
} else {
  console.log(`Compared with the median of ${history.length} earlier run(s) on "${run.machine}":`)
  for (const [key, value] of Object.entries(flat)) {
    const earlier = history.map((entry) => entry.metrics[key]).filter((v) => typeof v === 'number')
    if (!earlier.length) {
      console.log(`  new     ${key} = ${value}`)
      continue
    }
    const reference = median(earlier)
    const metric = key.split('.').pop()
    const worse = value > reference * (1 + tolerance) && value - reference > floorFor(metric)
    if (worse) regressions++
    const change = reference ? `${(((value - reference) / reference) * 100).toFixed(0)}%` : '-'
    console.log(
      `  ${worse ? 'WORSE' : 'ok   '}   ${key.padEnd(44)} ${String(reference).padStart(10)} -> ${String(value).padStart(10)}  ${change}`
    )
  }
}

fs.appendFileSync(
  trendFile,
  JSON.stringify({
    date: run.date,
    commit: process.env.GITHUB_SHA ?? process.env.PERF_COMMIT ?? null,
    machine: run.machine,
    metrics: flat
  }) + '\n'
)

if (regressions) {
  console.error(
    `\n${regressions} metric(s) more than ${tolerance * 100}% worse than recent runs. See perf/README.md.`
  )
  process.exit(1)
}
