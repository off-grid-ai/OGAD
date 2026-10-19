// Run many capture workers in parallel on one machine. Each worker gets its own seed range and
// output files, so runs from several machines merge without clashes.
//
// node scripts/action-data/run.mjs --workers 6 --episodes 100 --seed mac-1 --out outputs/action-data/run1

import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]])
  return pairs
}, []))
const workers = Number(args.workers ?? 4)
const first = Number(args['first-worker'] ?? 0)
const out = args.out ?? 'outputs/action-data/run'
const capture = join(dirname(fileURLToPath(import.meta.url)), 'capture.mjs')
const started = Date.now()

const runs = Array.from({ length: workers }, (_, i) => new Promise((resolve) => {
  const child = spawn(process.execPath, [
    capture, '--worker', String(first + i), '--episodes', String(args.episodes ?? 50),
    '--seed', args.seed ?? 'run', '--out', out, '--noise', String(args.noise ?? 0.12), '--family', args.family ?? '', '--settle', String(args.settle ?? 0), ...(args.view ? ['--view', args.view] : []), ...(args.policy ? ['--policy', args.policy, '--policy-rate', String(args['policy-rate'] ?? 0.7)] : [])
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let errors = ''
  child.stderr.on('data', (chunk) => { if (!/MaxListeners|trace-warnings/.test(chunk)) errors += chunk })
  child.on('exit', (code) => resolve({ worker: first + i, code, errors: errors.slice(0, 500) }))
}))

const results = await Promise.all(runs)
const totals = { workers, seconds: (Date.now() - started) / 1000, episodes: 0, completed: 0, actorRows: 0, evaluatorRows: 0, plannerRows: 0, actions: 0, verdicts: {}, families: {}, reasons: {} }
for (const { worker } of results) {
  const file = join(out, `summary-w${worker}.json`)
  if (!existsSync(file)) continue
  const s = JSON.parse(readFileSync(file, 'utf8'))
  for (const key of ['episodes', 'completed', 'actorRows', 'evaluatorRows', 'plannerRows', 'actions']) totals[key] += s[key]
  for (const key of ['findSteps', 'scrollForView']) if (s[key]) totals[key] = (totals[key] ?? 0) + s[key]
  for (const group of ['reasons', 'verdicts', 'families']) {
    for (const [key, count] of Object.entries(s[group])) totals[group][key] = (totals[group][key] ?? 0) + count
  }
}
totals.actorRowsPerHour = Math.round(totals.actorRows / totals.seconds * 3600)
console.log(JSON.stringify({ ...totals, failedWorkers: results.filter((r) => r.code !== 0) }, null, 2))
