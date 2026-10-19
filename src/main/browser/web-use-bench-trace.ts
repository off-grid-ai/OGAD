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
  plan?: string[]
  finalPage?: string
  end?: string
  detail?: string
  seconds?: number
}

/** The task the runner is on; browser-agent-task.ts records into it while it is set. */
export const benchTrace: { current: BenchRecord | null } = { current: null }
