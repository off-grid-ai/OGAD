#!/usr/bin/env node
// Rewrite scripts/config/vitest-timings.json, the file run times the CI shards are balanced by
// (scripts/config/vitest-duration-sequencer.ts), from the results of a full CI run.
//
//   gh run download <run id> --pattern 'vitest-results-*' --dir /tmp/vitest-results
//   node scripts/update-vitest-timings.mjs /tmp/vitest-results
//
// Each unit shard saves its `vitest --reporter=json` results as a vitest-results-<n> artifact. Every
// file in them is written with its run time in seconds, keyed by its path from this directory; a file
// the results do not hold keeps no entry, and the sequencer estimates it from its size.
import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { join, relative, sep } from 'path'
import { fileURLToPath } from 'url'

const TIMINGS_FILE = fileURLToPath(new URL('./config/vitest-timings.json', import.meta.url))

function main([dir]) {
  if (!dir) throw new Error('usage: update-vitest-timings.mjs <directory of vitest json results>')
  const timings = {}
  for (const file of readdirSync(dir, { recursive: true }).filter((name) =>
    name.endsWith('.json')
  )) {
    for (const result of JSON.parse(readFileSync(join(dir, file), 'utf8')).testResults) {
      const key = relative(process.cwd(), result.name).split(sep).join('/')
      timings[key] = Math.round((result.endTime - result.startTime) / 100) / 10
    }
  }
  const files = Object.keys(timings).sort()
  if (files.length === 0) throw new Error(`no vitest results under ${dir}`)
  writeFileSync(
    TIMINGS_FILE,
    `${JSON.stringify(Object.fromEntries(files.map((key) => [key, timings[key]])), null, 2)}\n`
  )
  console.log(`Recorded the run times of ${files.length} test files.`)
}

try {
  main(process.argv.slice(2))
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
