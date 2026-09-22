import { llm } from '../llm'
import { extractJsonObject } from '../json-extract'
import {
  currentRemoteScreenTaskSession,
  recordComputerUseMetric,
  recordComputerUseModelCall
} from '../actions/remote-screen-session'
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
  currentState?: string
  signal?: AbortSignal
  generate?: (prompt: string, signal?: AbortSignal) => Promise<string>
}

/** Generate the one stable, user-visible plan used by every task surface. */
export async function createTaskExecutionPlan(
  request: TaskExecutionPlanRequest
): Promise<TaskExecutionPlan> {
  const startedAt = Date.now()
  const prompt = taskPlanPrompt(
    request.goal,
    request.targetLabel,
    request.surface,
    request.currentState
  )
  const generate =
    request.generate ??
    (async (input: string, signal?: AbortSignal) => {
      const session = currentRemoteScreenTaskSession()
      const model = session?.activeServer ? undefined : llm.activeModelInfo()?.id
      const modelRequest = { prompt: input, responseFormat: TASK_PLAN_RESPONSE_FORMAT }
      const modelStartedAt = Date.now()
      recordComputerUseMetric('reasoningCalls')
      try {
        const response = await llm.chat(input, [], undefined, undefined, {
          enableThinking: true,
          responseFormat: TASK_PLAN_RESPONSE_FORMAT,
          signal
        })
        await recordComputerUseModelCall({
          role: 'reasoning',
          stage: 'task_plan',
          rail: request.surface === 'computer' ? 'ax' : 'vision',
          ...(model ? { model } : {}),
          request: modelRequest,
          response,
          startedAt: modelStartedAt
        })
        return response
      } catch (error) {
        await recordComputerUseModelCall({
          role: 'reasoning',
          stage: 'task_plan',
          rail: request.surface === 'computer' ? 'ax' : 'vision',
          ...(model ? { model } : {}),
          request: modelRequest,
          error,
          startedAt: modelStartedAt
        })
        throw error
      }
    })
  try {
    const raw = await generate(prompt, request.signal)
    const json = extractJsonObject(raw)
    const plan = json ? normalizeTaskExecutionPlan(JSON.parse(json)) : null
    const resolved = plan ?? fallbackTaskExecutionPlan(request.targetLabel, request.surface)
    console.log(
      `[${request.surface}-task] inference=task-plan durationMs=${Date.now() - startedAt} inputChars=${prompt.length} phases=${resolved.phases.length}`
    )
    return resolved
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
