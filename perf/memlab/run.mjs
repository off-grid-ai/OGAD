#!/usr/bin/env node
// memlab leak check (npm run perf:leaks). Runs perf/e2e/leaks.memlab.ts to take the baseline,
// target and final heap snapshots of the renderer, asks memlab for leak clusters, and fails when
// there are more than perf/memlab-budget.json allows. Writes a results file perf/trend.mjs reads.
//
// Env: PERF_SNAPSHOTS (snapshot dir), PERF_RESULTS (results file). Skip the app run and only
// analyse existing snapshots with --analyse-only.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findLeaksBySnapshotFilePaths } from '@memlab/api'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const snapshotDir = process.env.PERF_SNAPSHOTS ?? path.join(root, 'perf', 'results', 'snapshots')
const resultsFile = process.env.PERF_RESULTS ?? path.join(root, 'perf', 'results', 'memlab.json')
const budget = JSON.parse(fs.readFileSync(path.join(root, 'perf', 'memlab-budget.json'), 'utf8'))

if (!process.argv.includes('--analyse-only')) {
  execFileSync('npx', ['playwright', 'test', '--config', 'perf/playwright.perf.config.ts'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, PERF_SUITE: 'leaks', PERF_SNAPSHOTS: snapshotDir }
  })
}

const file = (name) => path.join(snapshotDir, `${name}.heapsnapshot`)
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-memlab-work-'))
const leaks = await findLeaksBySnapshotFilePaths(file('baseline'), file('target'), file('final'), {
  workDir
})
fs.rmSync(workDir, { recursive: true, force: true })

const sizeMB = (name) => fs.statSync(file(name)).size / 1_048_576
const metrics = {
  leakClusters: leaks.length,
  finalOverBaselineSnapshotMB: Number((sizeMB('final') - sizeMB('baseline')).toFixed(2))
}
fs.mkdirSync(path.dirname(resultsFile), { recursive: true })
fs.writeFileSync(
  resultsFile,
  JSON.stringify(
    {
      date: new Date().toISOString(),
      machine: `${os.platform()} ${os.cpus()[0]?.model ?? 'unknown'} x${os.cpus().length}`,
      results: { settingsLeaks: metrics }
    },
    null,
    2
  ) + '\n'
)

console.log(`\nmemlab: ${JSON.stringify(metrics)}  (budget: ${JSON.stringify(budget)})`)
if (
  metrics.leakClusters > budget.maxLeakClusters ||
  metrics.finalOverBaselineSnapshotMB > budget.maxFinalOverBaselineSnapshotMB
) {
  console.error('Settings leaks more than perf/memlab-budget.json allows. See perf/README.md.')
  process.exit(1)
}
