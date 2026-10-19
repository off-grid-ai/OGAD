import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WebUseAgentModels } from '../../shared/web-use-settings'
import { setWebUseSettingsOverride } from '../web-use-settings'
import { benchTrace, type BenchRecord } from './web-use-bench-trace'

/**
 * Web Use task list runner (development): runs benchmark tasks one by one through the real Web
 * Use path (getWebUseRailHost().runTask) in the app's own browser pane, with the
 * planner_actor_evaluator strategy, and writes one file per task in the shape the benchmark
 * judge reads (scripts/action-data/e2e/judge.py: id, end, detail, steps, finalPage, seconds).
 *
 *   OFFGRID_WEBUSE_BENCH=<tasks.json>        a list of { id, goal, url } (tasks-v2-live.json)
 *   OFFGRID_WEBUSE_BENCH_OUT=<dir>           where the task files go
 *   OFFGRID_WEBUSE_BENCH_MODELS=<json>       the four endpoints (WebUseAgentModels), for this run only
 *   OFFGRID_WEBUSE_BENCH_ONLY=<id,id>        optional: only these tasks
 *   OFFGRID_WEBUSE_BENCH_LIMIT_MS=<ms>       optional: time limit per task (default 6 minutes)
 */

export { benchTrace, type BenchRecord }

interface BenchTask {
  id: string
  goal: string
  url?: string
}

/** The browser the runner drives: run one Web Use task, and close a finished task's pages. */
export interface BenchBrowser {
  runTask: (request: {
    goal: string
    url?: string
    taskId: string
    journeyId: string
  }) => Promise<{ ok: boolean; summary: string }>
  closeJourney: (journeyId: string) => void
}

/** The app's own browser pane (the Web Use rail host). */
async function appBrowser(): Promise<BenchBrowser> {
  const { getWebUseRailHost } = await import('./web-use-host')
  const { closeBrowserJourney } = await import('./browser-host')
  return {
    runTask: (request) => getWebUseRailHost().runTask(request),
    closeJourney: closeBrowserJourney
  }
}

export async function startWebUseBench(browser?: BenchBrowser): Promise<void> {
  const tasksPath = process.env.OFFGRID_WEBUSE_BENCH
  const out = process.env.OFFGRID_WEBUSE_BENCH_OUT
  if (!tasksPath || !out) return
  const only = process.env.OFFGRID_WEBUSE_BENCH_ONLY?.split(',').filter(Boolean)
  const limitMs = Number(process.env.OFFGRID_WEBUSE_BENCH_LIMIT_MS) || 6 * 60_000
  const models = process.env.OFFGRID_WEBUSE_BENCH_MODELS
    ? (JSON.parse(process.env.OFFGRID_WEBUSE_BENCH_MODELS) as WebUseAgentModels)
    : undefined
  setWebUseSettingsOverride({
    modelStrategy: 'planner_actor_evaluator',
    browserTarget: 'in_app',
    ...(models ? { agentModels: models } : {})
  })
  mkdirSync(out, { recursive: true })
  const tasks = (JSON.parse(readFileSync(tasksPath, 'utf8')) as BenchTask[]).filter(
    (task) => !task.id.startsWith('clone-') && (!only || only.includes(task.id))
  )
  const pane = browser ?? (await appBrowser())
  console.log(`[web-use][bench] ${tasks.length} tasks -> ${out}`)
  const results: Record<string, unknown>[] = []
  for (const task of tasks) {
    const record: BenchRecord = {
      id: task.id,
      goal: task.goal,
      url: task.url ?? '',
      steps: [],
      timings: { planner: [], actor: [], evaluator: [], answerer: [] }
    }
    benchTrace.current = record
    const started = Date.now()
    let timer: NodeJS.Timeout | undefined
    try {
      const result = await Promise.race([
        pane.runTask({
          goal: task.goal,
          url: task.url,
          taskId: `bench-${task.id}-${started}`,
          journeyId: `bench-${task.id}-${started}`
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('time limit')), limitMs)
        })
      ])
      record.end ??= result.ok ? 'success' : 'gave_up'
      record.detail ??= result.ok ? `success(${JSON.stringify(result.summary)})` : result.summary
    } catch (error) {
      record.end = 'crash'
      record.detail = error instanceof Error ? error.message : String(error)
    } finally {
      clearTimeout(timer)
    }
    record.seconds = (Date.now() - started) / 1000
    benchTrace.current = null
    // Close the task's pages so tabs do not pile up across the list.
    pane.closeJourney(`bench-${task.id}-${started}`)
    writeFileSync(join(out, `${task.id}.json`), JSON.stringify(record, null, 2))
    results.push({
      id: record.id,
      end: record.end,
      detail: record.detail.slice(0, 200),
      seconds: record.seconds
    })
    console.log('[web-use][bench]', JSON.stringify(results.at(-1)))
  }
  writeFileSync(
    join(out, 'summary.json'),
    JSON.stringify({ tasks: results.length, results }, null, 2)
  )
  setWebUseSettingsOverride(null)
  console.log('[web-use][bench] done')
}
