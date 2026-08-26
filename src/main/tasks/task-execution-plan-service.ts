import { llm } from '../llm'
import { extractJsonObject } from '../json-extract'
import {
  TASK_PLAN_RESPONSE_FORMAT,
  encodeTaskExecutionPlan,
  fallbackTaskExecutionPlan,
  normalizeTaskExecutionPlan,
  taskPlanPrompt,
  type TaskExecutionPlan,
  type TaskExecutionSurface
} from '../../shared/task-execution-plan'

export interface TaskExecutionPlanRequest {
  goal: string
  surface: TaskExecutionSurface
  targetLabel?: string
  signal?: AbortSignal
  generate?: (prompt: string, signal?: AbortSignal) => Promise<string>
}

/** Generate the one stable, user-visible plan used by every task surface. */
export async function createTaskExecutionPlan(
  request: TaskExecutionPlanRequest
): Promise<TaskExecutionPlan> {
  const prompt = taskPlanPrompt(request.goal, request.targetLabel, request.surface)
  const generate =
    request.generate ??
    ((input: string, signal?: AbortSignal) =>
      llm.chat(input, [], 45_000, 280, {
        disableThinking: true,
        responseFormat: TASK_PLAN_RESPONSE_FORMAT,
        signal
      }))
  try {
    const raw = await generate(prompt, request.signal)
    const json = extractJsonObject(raw)
    const plan = json ? normalizeTaskExecutionPlan(JSON.parse(json)) : null
    return plan ?? fallbackTaskExecutionPlan(request.targetLabel, request.surface)
  } catch (error) {
    if (request.signal?.aborted) throw request.signal.reason ?? error
    console.warn(`[${request.surface}-task] plan generation used fallback:`, error)
    return fallbackTaskExecutionPlan(request.targetLabel, request.surface)
  }
}

export async function prepareTaskExecutionPlan(
  request: TaskExecutionPlanRequest,
  recordStep: (marker: string) => void
): Promise<TaskExecutionPlan> {
  const plan = await createTaskExecutionPlan(request)
  recordStep(encodeTaskExecutionPlan(plan))
  return plan
}

export function formatTaskExecutionPlanContext(plan: TaskExecutionPlan): string {
  return `Execution plan:\n${plan.phases
    .map((phase, index) => `${index + 1}. ${phase.title}`)
    .join('\n')}`
}

/** Reports phase transitions once, while keeping phase choice inside the task loop. */
export function createTaskPhaseReporter(
  plan: TaskExecutionPlan | undefined,
  report: ((phaseId: string) => void) | undefined
): (phaseIndex: number) => void {
  let currentPhaseId: string | null = null
  return (phaseIndex) => {
    if (!plan?.phases.length || !report) return
    const boundedIndex = Math.max(0, Math.min(phaseIndex, plan.phases.length - 1))
    const phaseId = plan.phases[boundedIndex]?.id
    if (!phaseId || phaseId === currentPhaseId) return
    currentPhaseId = phaseId
    report(phaseId)
  }
}
