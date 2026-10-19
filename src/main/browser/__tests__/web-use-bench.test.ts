/**
 * The Web Use task list runner (development): reads the task list, runs each task in the browser,
 * and writes one record per task plus a summary in the shape the benchmark judge reads. The browser
 * is faked at its boundary (run one task, close its pages); the runner itself is real.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { benchTrace, startWebUseBench, type BenchBrowser } from '../web-use-bench'

const ENV = [
  'OFFGRID_WEBUSE_BENCH',
  'OFFGRID_WEBUSE_BENCH_OUT',
  'OFFGRID_WEBUSE_BENCH_ONLY',
  'OFFGRID_WEBUSE_BENCH_LIMIT_MS',
  'OFFGRID_WEBUSE_BENCH_MODELS'
] as const

let dir = ''

afterEach(() => {
  for (const key of ENV) delete process.env[key]
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

describe('Web Use task list runner', () => {
  it('does nothing without a task list and an output folder', async () => {
    let ran = false
    await startWebUseBench({
      runTask: async () => ((ran = true), { ok: true, summary: '' }),
      closeJourney: () => undefined
    })
    expect(ran).toBe(false)
  })

  it('records every task it runs, whether it succeeds, gives up, crashes or runs out of time', async () => {
    dir = mkdtempSync(join(tmpdir(), 'offgrid-bench-'))
    const tasksPath = join(dir, 'tasks.json')
    const out = join(dir, 'out')
    writeFileSync(
      tasksPath,
      JSON.stringify([
        { id: 'price', goal: 'Find the price', url: 'https://shop.test/' },
        { id: 'login', goal: 'Sign in' },
        { id: 'crash', goal: 'Open the broken page' },
        { id: 'slow', goal: 'Wait forever' },
        { id: 'skipped', goal: 'Not in the list to run' },
        { id: 'clone-mail', goal: 'A local clone task, never run here' }
      ])
    )
    process.env.OFFGRID_WEBUSE_BENCH = tasksPath
    process.env.OFFGRID_WEBUSE_BENCH_OUT = out
    process.env.OFFGRID_WEBUSE_BENCH_ONLY = 'price,login,crash,slow,clone-mail'
    process.env.OFFGRID_WEBUSE_BENCH_LIMIT_MS = '50'
    process.env.OFFGRID_WEBUSE_BENCH_MODELS = JSON.stringify({
      planner: { baseUrl: 'http://127.0.0.1:8471/v1', model: 'planner' },
      actor: { baseUrl: 'http://127.0.0.1:8472/v1', model: 'actor' },
      evaluator: { baseUrl: 'http://127.0.0.1:8473/v1', model: 'evaluator' }
    })

    const closed: string[] = []
    const tracedWhileRunning: Array<string | undefined> = []
    const browser: BenchBrowser = {
      runTask: async ({ goal }) => {
        tracedWhileRunning.push(benchTrace.current?.goal)
        if (goal === 'Find the price') return { ok: true, summary: '₹420' }
        if (goal === 'Sign in') return { ok: false, summary: 'Needs a password' }
        if (goal === 'Open the broken page') throw new Error('renderer gone')
        return new Promise(() => undefined)
      },
      closeJourney: (journeyId) => void closed.push(journeyId)
    }

    await startWebUseBench(browser)

    const record = (id: string): Record<string, unknown> =>
      JSON.parse(readFileSync(join(out, `${id}.json`), 'utf8')) as Record<string, unknown>
    expect(record('price')).toMatchObject({
      end: 'success',
      detail: 'success("₹420")',
      url: 'https://shop.test/'
    })
    expect(record('login')).toMatchObject({ end: 'gave_up', detail: 'Needs a password', url: '' })
    expect(record('crash')).toMatchObject({ end: 'crash', detail: 'renderer gone' })
    expect(record('slow')).toMatchObject({ end: 'crash', detail: 'time limit' })
    const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')) as {
      tasks: number
      results: Array<{ id: string; end: string }>
    }
    expect(summary.tasks).toBe(4)
    expect(summary.results.map((result) => result.id)).toEqual(['price', 'login', 'crash', 'slow'])
    // The trace is the running task's while it runs, and cleared after; each task's pages close.
    expect(tracedWhileRunning).toEqual([
      'Find the price',
      'Sign in',
      'Open the broken page',
      'Wait forever'
    ])
    expect(benchTrace.current).toBeNull()
    expect(closed).toHaveLength(4)
    expect(closed.every((journey) => journey.startsWith('bench-'))).toBe(true)
  })
})
