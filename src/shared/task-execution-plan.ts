export const TASK_PLAN_PREFIX = 'TASK PLAN · '
export const TASK_PHASE_PREFIX = 'TASK PHASE · '

export interface TaskExecutionPhase {
  id: string
  title: string
}

export interface TaskExecutionPlan {
  version: 1
  phases: TaskExecutionPhase[]
}

export type TaskExecutionSurface = 'web' | 'computer'

function cleanTitle(value: unknown): string | null {
  const source =
    typeof value === 'string'
      ? value
      : value &&
          typeof value === 'object' &&
          typeof (value as { title?: unknown }).title === 'string'
        ? ((value as { title: string }).title ?? '')
        : ''
  const title = source.replace(/\s+/g, ' ').trim().slice(0, 100)
  return title.length >= 3 ? title : null
}

export function normalizeTaskExecutionPlan(value: unknown): TaskExecutionPlan | null {
  if (!value || typeof value !== 'object') return null
  const phases = (value as { phases?: unknown }).phases
  if (!Array.isArray(phases)) return null
  const titles = phases
    .map(cleanTitle)
    .filter((title): title is string => Boolean(title))
    .slice(0, 7)
  if (titles.length < 2) return null
  return {
    version: 1,
    phases: titles.map((title, index) => ({ id: `phase-${index + 1}`, title }))
  }
}

export function fallbackTaskExecutionPlan(
  targetLabel?: string,
  surface: TaskExecutionSurface = 'web'
): TaskExecutionPlan {
  if (surface === 'computer') {
    const target = targetLabel ? `Open ${targetLabel}` : 'Open the target app'
    return normalizeTaskExecutionPlan({
      phases: [target, 'Complete the requested work', 'Verify the result']
    })!
  }
  const target = targetLabel ? `Open ${targetLabel}` : 'Open the target page'
  return normalizeTaskExecutionPlan({
    phases: [
      target,
      'Enter the requested details',
      'Complete the requested action',
      'Verify the result'
    ]
  })!
}

export function encodeTaskExecutionPlan(plan: TaskExecutionPlan): string {
  return `${TASK_PLAN_PREFIX}${JSON.stringify(plan)}`
}

export function decodeTaskExecutionPlan(step: string): TaskExecutionPlan | null {
  if (!step.startsWith(TASK_PLAN_PREFIX)) return null
  try {
    return normalizeTaskExecutionPlan(JSON.parse(step.slice(TASK_PLAN_PREFIX.length)))
  } catch {
    return null
  }
}

export function encodeTaskPhase(phaseId: string): string {
  return `${TASK_PHASE_PREFIX}${phaseId}`
}

export function decodeTaskPhase(step: string): string | null {
  if (!step.startsWith(TASK_PHASE_PREFIX)) return null
  const id = step.slice(TASK_PHASE_PREFIX.length).trim()
  return /^phase-[1-7]$/.test(id) ? id : null
}

export function isTaskPlanControlStep(step: string): boolean {
  return step.startsWith(TASK_PLAN_PREFIX) || step.startsWith(TASK_PHASE_PREFIX)
}

export function taskExecutionPlanProgress(
  steps: readonly string[]
): { plan: TaskExecutionPlan; activePhaseIndex: number } | null {
  const plan = steps.map(decodeTaskExecutionPlan).find(Boolean)
  if (!plan) return null
  let activePhaseIndex = 0
  for (const step of steps) {
    const phaseId = decodeTaskPhase(step)
    if (!phaseId) continue
    const index = plan.phases.findIndex((phase) => phase.id === phaseId)
    if (index >= 0) activePhaseIndex = Math.max(activePhaseIndex, index)
  }
  return { plan, activePhaseIndex }
}

export function countTaskTraceSteps(steps: readonly string[]): number {
  return steps.filter((step) => !isTaskPlanControlStep(step)).length
}

export function taskPlanPrompt(
  goal: string,
  targetLabel?: string,
  surface: TaskExecutionSurface = 'web'
): string {
  const agent = surface === 'computer' ? 'computer-use agent' : 'web agent'
  const target = surface === 'computer' ? 'Target app' : 'Starting website'
  return [
    `Create a short execution plan for a ${agent}.`,
    `User goal: ${goal}`,
    targetLabel ? `${target}: ${targetLabel}` : '',
    'Return 3 to 6 outcome-based phases in the order the user and agent should expect.',
    'Use short titles such as "Open booking.com" or "Set the travel filters".',
    'Do not include individual clicks, typing actions, hidden reasoning, or safety policy.',
    'Reply with only JSON: {"phases":["First phase","Second phase","Final phase"]}'
  ]
    .filter(Boolean)
    .join('\n')
}

export const TASK_PLAN_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'task_execution_plan',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        phases: {
          type: 'array',
          minItems: 2,
          maxItems: 7,
          items: { type: 'string' }
        }
      },
      required: ['phases']
    }
  }
} as const
