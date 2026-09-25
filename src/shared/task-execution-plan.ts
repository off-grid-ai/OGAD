export const TASK_PLAN_PREFIX = 'TASK PLAN · '
export const TASK_PHASE_PREFIX = 'TASK PHASE · '
export const TASK_PHASE_RESUME_PREFIX = 'TASK RESUME PHASE · '

export interface TaskExecutionPhase {
  id: string
  title: string
  operation?: TaskExecutionOperation
  completion?: TaskExecutionCompletion
}

export type TaskExecutionOperationKind =
  | 'clear'
  | 'type'
  | 'activate'
  | 'select'
  | 'set_value'
  | 'navigate'

export interface TaskExecutionOperation {
  kind: TaskExecutionOperationKind
  target?: string
  value?: string
}

export type TaskExecutionCompletion =
  | { kind: 'field_empty' }
  | { kind: 'field_value'; value: string }
  | { kind: 'selected_identity'; value: string }
  | { kind: 'visible_identity'; value: string }

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


function parsedPhaseOperation(value: unknown): TaskExecutionOperation | undefined {
  if (!value || typeof value !== 'object') return undefined
  const operation = (value as { operation?: unknown }).operation
  if (!operation || typeof operation !== 'object') return undefined
  const kind = (operation as { kind?: unknown }).kind
  if (
    kind !== 'clear' &&
    kind !== 'type' &&
    kind !== 'activate' &&
    kind !== 'select' &&
    kind !== 'set_value' &&
    kind !== 'navigate'
  ) {
    return undefined
  }
  const target = (operation as { target?: unknown }).target
  const operationValue = (operation as { value?: unknown }).value
  return {
    kind,
    ...(typeof target === 'string' && target.trim() ? { target: target.trim().slice(0, 160) } : {}),
    ...(typeof operationValue === 'string' && operationValue.trim()
      ? { value: operationValue.trim().slice(0, 160) }
      : {})
  }
}

function completionForOperation(
  operation: TaskExecutionOperation
): TaskExecutionCompletion | undefined {
  if (operation.kind === 'clear') return { kind: 'field_empty' }
  if (operation.kind === 'type' && operation.value) {
    return { kind: 'field_value', value: operation.value }
  }
  if (operation.kind === 'select' && (operation.value ?? operation.target)) {
    return { kind: 'selected_identity', value: operation.value ?? operation.target! }
  }
  if (
    (operation.kind === 'navigate' || operation.kind === 'set_value') &&
    (operation.value ?? operation.target)
  ) {
    return { kind: 'visible_identity', value: operation.value ?? operation.target! }
  }
  return undefined
}

export function normalizeTaskExecutionPlan(value: unknown): TaskExecutionPlan | null {
  if (!value || typeof value !== 'object') return null
  const phases = (value as { phases?: unknown }).phases
  if (!Array.isArray(phases)) return null
  const normalizedPhases = phases
    .flatMap((phase) => {
      const title = cleanTitle(phase)
      if (!title) return []
      const operation = parsedPhaseOperation(phase)
      return [{ title, operation }]
    })
    .slice(0, 7)
  if (normalizedPhases.length < 1) return null
  return {
    version: 1,
    phases: normalizedPhases.map(({ title, operation }, index) => {
      const completion = operation ? completionForOperation(operation) : undefined
      return {
        id: `phase-${index + 1}`,
        title,
        ...(operation ? { operation, ...(completion ? { completion } : {}) } : {})
      }
    })
  }
}

export function fallbackTaskExecutionPlan(
  targetLabel?: string,
  surface: TaskExecutionSurface = 'web'
): TaskExecutionPlan {
  const surfaceLabel = surface === 'computer' ? 'app' : 'page'
  return {
    version: 1,
    phases: [
      {
        id: 'phase-1',
        title: targetLabel
          ? `Complete the requested work in ${targetLabel}`
          : `Complete the requested work in the target ${surfaceLabel}`
      }
    ]
  }
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

export function encodeTaskPhaseResume(phaseId: string): string {
  return `${TASK_PHASE_RESUME_PREFIX}${phaseId}`
}

/** Restore the durable control records from a portable plan projection. */
export function encodeTaskExecutionPlanProgress(
  plan: TaskExecutionPlan,
  activePhaseIndex: number
): string[] {
  const activePhase = plan.phases[activePhaseIndex]
  return [encodeTaskExecutionPlan(plan), ...(activePhase ? [encodeTaskPhase(activePhase.id)] : [])]
}

export function decodeTaskPhase(step: string): string | null {
  if (!step.startsWith(TASK_PHASE_PREFIX)) return null
  const id = step.slice(TASK_PHASE_PREFIX.length).trim()
  return /^phase-[1-7]$/.test(id) ? id : null
}

export function decodeTaskPhaseResume(step: string): string | null {
  if (!step.startsWith(TASK_PHASE_RESUME_PREFIX)) return null
  const id = step.slice(TASK_PHASE_RESUME_PREFIX.length).trim()
  return /^phase-[1-7]$/.test(id) ? id : null
}

export function isTaskPlanControlStep(step: string): boolean {
  return (
    step.startsWith(TASK_PLAN_PREFIX) ||
    step.startsWith(TASK_PHASE_PREFIX) ||
    step.startsWith(TASK_PHASE_RESUME_PREFIX)
  )
}

export function taskExecutionPlanProgress(
  steps: readonly string[]
): { plan: TaskExecutionPlan; activePhaseIndex: number } | null {
  const plan = steps.map(decodeTaskExecutionPlan).find(Boolean)
  if (!plan) return null
  let activePhaseIndex = 0
  for (const step of steps) {
    const resumedPhaseId = decodeTaskPhaseResume(step)
    if (resumedPhaseId) {
      const index = plan.phases.findIndex((phase) => phase.id === resumedPhaseId)
      if (index >= 0) activePhaseIndex = index
      continue
    }
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
  surface: TaskExecutionSurface = 'web',
  currentState?: string
): string {
  const agent = surface === 'computer' ? 'computer-use agent' : 'web agent'
  const target = surface === 'computer' ? 'Target app' : 'Starting website'
  const surfaceRules =
    surface === 'web'
      ? [
          'Each phase must end in a page state that the web agent can confirm from the visible page.',
          'For search or form tasks, put each route, date, filter, or other constraint in exactly one setup phase. Do not repeat those constraints in a later results phase.',
          'Use navigation as its own phase only when opening the correct website or page is a distinct prerequisite.'
        ]
      : [
          'The target app is already open and focused before this plan begins. Do not add a phase to open the target app.',
          'An open app and an open page, document, view, or location are different states. Do not treat the requested page or view as complete only because its app is open.',
          'When the goal provides an exact public URL and that exact page is not already visible, use one navigate operation with the exact URL. Do not replace it with address-bar typing or an in-site route unless the goal requires that interaction.',
          'Base the plan on the current visible app state. Do not invent an input field, control, or app state that is not present.',
          'Include any required app mode, view, panel, or document state as a distinct outcome before a phase that uses it.',
          'Each phase must end in an app state that the computer-use agent can confirm from the visible interface.'
        ]
  return [
    `Create a short execution plan for a ${agent}.`,
    `User goal: ${goal}`,
    targetLabel ? `${target}: ${targetLabel}` : '',
    currentState ? `Current visible app state:\n${currentState}` : '',
    'Return 1 to 4 outcome-based phases in the order the user and agent should expect.',
    'Each phase must contain exactly one atomic operation. Never combine clear and type, type and select, search and open, or any other two operations in one phase.',
    'When work requires multiple operations, return one phase for each operation in execution order.',
    'Each phase starts from the confirmed result of the previous phase. Do not repeat a completed prerequisite or reopen, reselect, or re-enter state that an earlier phase established.',
    'Treat every completed prerequisite listed in the current state or user goal as already done. Continue from its result and never add it to the plan again.',
    'Use one phase when the task has one visible outcome. Add phases only for distinct prerequisite states.',
    'Stop at the exact outcome the user requested. Do not add later use, demonstration, interaction, or content that the user did not request.',
    'Make every phase a distinct, non-overlapping outcome. A phase must not repeat, contain, or depend on work assigned to a later phase.',
    'Include every required user detail in exactly one phase, after its prerequisites and before any phase that uses its result.',
    "Separate object descriptions from requested operations. An item's type, language, origin, format, or other descriptive attribute is identification context, not a request to change a filter, mode, or category.",
    'Add a filter, mode, view, or category phase only when the user explicitly requests that state or it is required by the visible interface to reach the requested result.',
    'If the current interface has an unrelated active filter, category, or scope, remove that restriction before locating the requested item.',
    'For item tasks, locate and select the exact requested item before any phase that previews it, opens its details, or changes its presentation view.',
    ...surfaceRules,
    'Keep the plan compact. Do not add a separate verification, reporting, or summary phase; the agent verifies each visible outcome while it works.',
    'Plan directly and keep internal reasoning brief. Spend the response on the required JSON plan.',
    'Name the visible result that completes the final phase. Do not use a generic phase such as "Complete the requested work" or "Verify the result".',
    'Use short, specific titles such as "Clear the search field", "Type AAPL", "Select AAPL", or "Show the AAPL details".',
    'For each phase, provide the single operation intent. Use target for the visible object or control and value for exact text or a selected value. Use null when target or value is not known.',
    "Use the exact visible label, or the common application-native action name when the control is not visible yet, in both the phase title and operation target. Use the application's action name even when the user described the same result with a different concept.",
    'Do not include individual click coordinates, hidden reasoning, or safety policy.',
    'Reply with only JSON: {"phases":[{"title":"Type AAPL in the search field","operation":{"kind":"type","target":"search field","value":"AAPL"}},{"title":"Select AAPL","operation":{"kind":"select","target":"AAPL","value":null}}]}'
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
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              operation: {
                type: 'object',
                properties: {
                  kind: {
                    type: 'string',
                    enum: ['clear', 'type', 'activate', 'select', 'set_value', 'navigate']
                  },
                  target: { type: ['string', 'null'] },
                  value: { type: ['string', 'null'] }
                },
                required: ['kind', 'target', 'value'],
                additionalProperties: false
              }
            },
            required: ['title', 'operation'],
            additionalProperties: false
          }
        }
      },
      required: ['phases']
    }
  }
} as const
