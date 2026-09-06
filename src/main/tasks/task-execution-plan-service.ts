/**
 * Desktop binding of the shared task planner: the model call, the JSON extraction, and the
 * diagnostics sink are the ports; the prompt, schema, normalisation, fallback plans, trace
 * encoding, and phase reporting are `@offgrid/automation`'s.
 */
import {
  encodeTaskExecutionPlan,
  planTaskExecution,
  TASK_PLAN_RESPONSE_FORMAT,
  type TaskExecutionPlan,
  type TaskExecutionPlanPorts,
  type TaskExecutionPlanRequest as SharedTaskExecutionPlanRequest
} from '@offgrid/automation'
import { generateDesktopText } from '../desktop-generation'
import { extractJsonObject } from '../json-extract'

export { createTaskPhaseReporter, formatTaskExecutionPlanContext } from '@offgrid/automation'

export interface TaskExecutionPlanRequest extends SharedTaskExecutionPlanRequest {
  /** Test seam: a model port other than the desktop text generator. */
  generate?: TaskExecutionPlanPorts['generate']
}

async function generateWithDesktopModel(prompt: string, signal?: AbortSignal): Promise<string> {
  const generated = await generateDesktopText(prompt, {
    responseFormat: TASK_PLAN_RESPONSE_FORMAT,
    profile: 'structured-step',
    signal
  })
  return generated.content
}

/** Generate the one stable, user-visible plan used by every task surface. */
export function createTaskExecutionPlan(
  request: TaskExecutionPlanRequest
): Promise<TaskExecutionPlan> {
  const { generate, ...planRequest } = request
  return planTaskExecution(planRequest, {
    generate: generate ?? generateWithDesktopModel,
    extractJson: extractJsonObject,
    warn: (surface, error) =>
      console.warn(`[${surface}-task] plan generation used fallback:`, error)
  })
}

export async function prepareTaskExecutionPlan(
  request: TaskExecutionPlanRequest,
  recordStep: (marker: string) => void
): Promise<TaskExecutionPlan> {
  const plan = await createTaskExecutionPlan(request)
  recordStep(encodeTaskExecutionPlan(plan))
  return plan
}
