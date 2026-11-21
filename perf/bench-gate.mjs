#!/usr/bin/env node
// Per-PR gate for the retrieval benchmarks (perf/bench). Runs `vitest bench` a few times, divides
// each benchmark's median time by the calibration workload's median time (so a faster or slower
// machine compares fairly), keeping the fastest median of the runs (noise only ever makes a run slower), and
// fails when a benchmark got more than TOLERANCE slower than perf/bench-baseline.json.
//
//   node perf/bench-gate.mjs            compare with the baseline
//   node perf/bench-gate.mjs --update   write the baseline from this machine
//
// Env: PERF_BENCH_RUNS (default 5), PERF_BENCH_TOLERANCE (default 0.10).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baselineFile = path.join(root, 'perf', 'bench-baseline.json')
const update = process.argv.includes('--update')
const runs = Number(process.env.PERF_BENCH_RUNS ?? 5)
const tolerance = Number(process.env.PERF_BENCH_TOLERANCE ?? 0.1)
const CALIBRATION = 'calibration > fixed CPU workload'

const runOnce = (index) => {
  const out = path.join(os.tmpdir(), `offgrid-bench-${process.pid}-${index}.json`)
  execFileSync(
    'npx',
    ['vitest', 'bench', '--config', 'vitest.bench.config.ts', '--run', '--outputJson', out],
    { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] }
  )
  const report = JSON.parse(fs.readFileSync(out, 'utf8'))
  fs.rmSync(out, { force: true })
  const medians = {}
  for (const file of report.files) {
    for (const group of file.groups) {
      const groupName = group.fullName.split(' > ').slice(1).join(' > ')
      for (const b of group.benchmarks) medians[`${groupName} > ${b.name}`] = b.median
    }
  }
  if (!medians[CALIBRATION]) throw new Error(`no "${CALIBRATION}" result`)
  return medians
}

// The fastest median of each benchmark across the runs, then each divided by the calibration's.
const fastest = {}
for (let i = 0; i < runs; i++) {
  for (const [name, value] of Object.entries(runOnce(i))) {
    fastest[name] = Math.min(fastest[name] ?? Infinity, value)
  }
}
const best = {}
for (const [name, value] of Object.entries(fastest)) {
  if (name !== CALIBRATION) best[name] = value / fastest[CALIBRATION]
}

if (update) {
  const rounded = Object.fromEntries(
    Object.entries(best)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => [name, Number(value.toFixed(4))])
  )
  fs.writeFileSync(
    baselineFile,
    JSON.stringify(
      {
        unit: 'median time ÷ calibration median time (lower is faster)',
        machine: `${os.cpus()[0]?.model ?? 'unknown'} · node ${process.version}`,
        recorded: new Date().toISOString().slice(0, 10),
        benchmarks: rounded
      },
      null,
      2
    ) + '\n'
  )
  console.log(`wrote ${path.relative(root, baselineFile)}`)
  process.exit(0)
}

const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8')).benchmarks
let failed = 0
const rows = []
for (const [name, value] of Object.entries(best)) {
  const was = baseline[name]
  if (was === undefined) {
    rows.push(['new', name, '-', value.toFixed(4), ''])
    continue
  }
  const change = value / was - 1
  const bad = change > tolerance
  if (bad) failed++
  rows.push([
    bad ? 'SLOWER' : 'ok',
    name,
    was.toFixed(4),
    value.toFixed(4),
    `${(change * 100).toFixed(1)}%`
  ])
}
for (const name of Object.keys(baseline)) {
  if (!(name in best)) rows.push(['gone', name, baseline[name].toFixed(4), '-', ''])
}
for (const row of rows)
  console.log(row.map((cell, i) => (i === 1 ? cell.padEnd(56) : cell.padStart(8))).join('  '))

if (failed) {
  console.error(
    `\n${failed} benchmark(s) more than ${tolerance * 100}% slower than perf/bench-baseline.json.` +
      '\nIf the slowdown is intended, run `npm run perf:bench -- --update` and commit the baseline.'
  )
  process.exit(1)
}
console.log(`\nAll benchmarks within ${tolerance * 100}% of the baseline.`)
