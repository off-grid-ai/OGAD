/**
 * The Web Use task list runner's record of the task it is on (web-use-bench.ts). Its own module, so
 * browser-agent-task.ts can record into it without importing the runner, which imports the browser
 * host that imports the agent task (an import cycle).
 */
export interface BenchRecord {
  id: string
  goal: string
  url: string
  steps: Record<string, unknown>[]
  timings: { planner: number[]; actor: number[]; evaluator: number[]; answerer: number[] }
  /** The task's own plan; sub-goal plans and results are in steps (nested planning). */
  plan?: string[]
  finalPage?: string
  end?: string
  detail?: string
  seconds?: number
  /** The pages the task opened, in order: where the agent went, for loop analysis. */
  visits?: { url: string; title: string; at: number }[]
  /** Each time the commit gate stopped to ask the person (browser-commit-gate.ts). */
  asks?: { what: string; url: string; at: number }[]
}

/** The task the runner is on; browser-agent-task.ts records into it while it is set. */
export const benchTrace: { current: BenchRecord | null } = { current: null }

/** Note a commit-gate question in the record of the task the runner is on. */
export function noteBenchAsk(what: string, url: string): void {
  const record = benchTrace.current
  if (record) (record.asks ??= []).push({ what, url, at: Date.now() })
}
