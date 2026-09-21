export const TASK_PLAN_PREFIX = 'TASK PLAN · '
export const TASK_PHASE_PREFIX = 'TASK PHASE · '

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

function explicitPhaseValue(title: string): string | undefined {
  return (
    /[`“"]([^`”"]{1,160})[`”"]/u.exec(title)?.[1]?.trim() ??
    /\bhttps?:\/\/[^\s]+/iu.exec(title)?.[0] ??
    title.match(/\b[A-Z][A-Z0-9._-]{1,15}\b/gu)?.at(-1)
  )
}

function referencedPhaseValue(title: string): string | undefined {
  const explicit = explicitPhaseValue(title)
  if (explicit) return explicit
  const typedValue = /^(?:enter|fill|type|write)\s+(.+)$/iu
    .exec(title)?.[1]
    ?.replace(/\s+(?:in|into|to)\s+.+\b(?:area|box|field|input)$/iu, '')
    ?.replace(
      /\s+(?:(?:in|into|to)\s+)?(?:the\s+)?(?:search\s+)?(?:area|box|field|input)$/iu,
      ''
    )
    .trim()
  if (typedValue && !/^(?:a|an|the|your)\b/iu.test(typedValue)) {
    const words = typedValue.split(/\s+/u)
    return words.length > 1 && words[0]!.toLocaleLowerCase() === words.at(-1)!.toLocaleLowerCase()
      ? words[0]
      : typedValue
  }
  const detailedTarget = /\b(?:detail|details|page|view)\s+(?:for|of)\s+(?:the\s+)?(.+)$/iu
    .exec(title)?.[1]
    ?.trim()
  if (detailedTarget) return detailedTarget
  return /^(?:find|locate|navigate to|open|select|show|view)\s+(?:the\s+)?(.+?)(?:\s+from\b|\s+in\b|\s+using\b|$)/iu
    .exec(title)?.[1]
    ?.replace(/\b(?:app|application|detail|details|result|results|row|view|window)\b.*$/iu, '')
    .trim()
}

function atomicPhaseTitles(title: string): string[] {
  const searchThenResult = /^(?:find|search)(?:\s+for)?\s+and\s+(locate|open|select)\s+(.+)$/iu.exec(
    title
  )
  if (searchThenResult) {
    const target = searchThenResult[2]!.trim()
    return [`Search for ${target}`, `${searchThenResult[1]} ${target}`]
  }
  const combined = /^(.+?)\s+(?:and then|and|then)\s+((?:activate|choose|clear|click|enter|fill|launch|navigate|open|press|select|set|show|switch|type|view|write)\b.*)$/iu.exec(
    title
  )
  if (!combined) return [title]
  const first = combined[1]!.trim()
  let second = combined[2]!.trim()
  const reference = referencedPhaseValue(first)
  if (reference) {
    second = second.replace(/\b(?:it|that item|that result|the item|the result)\b/iu, reference)
  }
  return first.length >= 3 && second.length >= 3 ? [first, second] : [title]
}

function phaseContract(title: string): Pick<TaskExecutionPhase, 'operation' | 'completion'> {
  const normalized = title.trim()
  const value = referencedPhaseValue(normalized)
  if (/^(?:clear|empty|erase|remove|reset)\b/iu.test(normalized)) {
    return { operation: { kind: 'clear', target: 'field' }, completion: { kind: 'field_empty' } }
  }
  if (/^(?:enter|fill|type|write)\b/iu.test(normalized)) {
    return value
      ? {
          operation: { kind: 'type', target: 'field', value },
          completion: { kind: 'field_value', value }
        }
      : { operation: { kind: 'type', target: 'field' } }
  }
  if (/^(?:select|choose|click|press|activate)\b/iu.test(normalized)) {
    return value
      ? {
          operation: { kind: 'select', target: value },
          completion: { kind: 'selected_identity', value }
        }
      : { operation: { kind: 'activate' } }
  }
  if (/^(?:set|change|adjust|switch|toggle|turn)\b/iu.test(normalized)) {
    return value
      ? {
          operation: { kind: 'set_value', value },
          completion: { kind: 'visible_identity', value }
        }
      : { operation: { kind: 'set_value' } }
  }
  if (/^(?:find|launch|locate|navigate|open|search|show|view)\b/iu.test(normalized)) {
    return value
      ? {
          operation: { kind: 'navigate', target: value },
          completion: { kind: 'visible_identity', value }
        }
      : { operation: { kind: 'navigate' } }
  }
  return {}
}

export function normalizeTaskExecutionPlan(value: unknown): TaskExecutionPlan | null {
  if (!value || typeof value !== 'object') return null
  const phases = (value as { phases?: unknown }).phases
  if (!Array.isArray(phases)) return null
  const titles = phases
    .map(cleanTitle)
    .filter((title): title is string => Boolean(title))
    .flatMap(atomicPhaseTitles)
    .slice(0, 7)
  if (titles.length < 1) return null
  return {
    version: 1,
    phases: titles.map((title, index) => ({
      id: `phase-${index + 1}`,
      title,
      ...phaseContract(title)
    }))
  }
}

function currentScopedLabel(currentState?: string): string | null {
  const title = /^Window:\s*([^\n]+)$/imu.exec(currentState ?? '')?.[1]?.trim() ?? ''
  const searchedScope = /^Searching\s+[\u201c"]([^\u201d"]+)[\u201d"]/iu.exec(title)?.[1]?.trim()
  const countedScope = /^(.+?)\s+[\u2013\u2014-]\s+\d+\s+of\s+\d+\b/iu.exec(title)?.[1]?.trim()
  const label = searchedScope ?? countedScope ?? ''
  if (/^(?:all|all items|all fonts|everything|unfiltered)$/iu.test(label)) return null
  return label.length >= 2 && label.length <= 60 ? label : null
}

/** Keep a generated plan grounded in the user's requested operations. A model
 * can mistake an item's descriptive attribute for a requested UI filter. When
 * it proposes changing an unrelated active scope into a goal attribute, clear
 * that scope instead. The agent can then locate the item from the unrestricted
 * view. */
export function groundTaskExecutionPlan(
  plan: TaskExecutionPlan,
  goal: string,
  currentState?: string,
  targetLabel?: string
): TaskExecutionPlan {
  const startNewRequest = /\bstart\s+(?:a|an)\s+new\s+(.+?)\s+(?:where|with|using)\s+(.+?)[.!?]*$/iu.exec(
    goal.trim()
  )
  const startGroundedPlan: TaskExecutionPlan = (() => {
    if (!startNewRequest) return plan
    const object = startNewRequest[1]!.trim()
    const condition = startNewRequest[2]!.trim()
    const conditionWords = condition.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []
    const prerequisite = plan.phases.find((phase) => {
      const title = phase.title.toLocaleLowerCase()
      return (
        /\b(?:adjust|change|choose|configure|set)\b/iu.test(title) &&
        conditionWords.some((word) => title.includes(word))
      )
    })
    return (
      normalizeTaskExecutionPlan({
        phases: [
          prerequisite?.title ?? `Set the required condition before starting: ${condition}`,
          `Start a new ${object} using the configured condition`
        ]
      }) ?? plan
    )
  })()
  const targetPattern = targetLabel?.trim()
    ? targetLabel.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    : null
  const targetGroundedPlan: TaskExecutionPlan = targetPattern
    ? {
        ...startGroundedPlan,
        phases: startGroundedPlan.phases.map((phase) => ({
          ...phase,
          title: phase.title
            .replace(new RegExp(`\\s+\\b(?:in|within|from|using)\\s+(?:the\\s+)?${targetPattern}\\b`, 'iu'), '')
            .replace(/\s+/g, ' ')
            .trim()
        }))
      }
    : startGroundedPlan
  const needsSelectedItem = /\b(?:preview|show|view|open)\b[^.!?]{0,80}\b(?:details?|preview|sample|styles?)\b|\bpreview\b/iu.test(
    goal
  )
  const hasSelectionPhase = startGroundedPlan.phases.some((phase) => /\bselect\b/iu.test(phase.title))
  const selectionGroundedPlan: TaskExecutionPlan =
    needsSelectedItem && !hasSelectionPhase
      ? {
          ...targetGroundedPlan,
          phases: targetGroundedPlan.phases.map((phase) => {
            const expandedItem = /^expand\s+(?:the\s+)?(.+?)(?:\s+(?:entry|item|row))?\s+to\b/iu.exec(
              phase.title
            )?.[1]?.trim()
            return expandedItem
              ? { ...phase, title: `Find and select ${expandedItem}` }
              : phase
          })
        }
      : targetGroundedPlan
  const previewTarget = selectionGroundedPlan.phases
    .map((phase) =>
      /\bselect\s+(?:the\s+)?(.+?)(?:\s+from\b|\s+to\b|\s+in\b|$)/iu.exec(
        phase.title
      )?.[1]?.trim()
    )
    .find((value): value is string => Boolean(value))
  const explicitPreviewTarget = selectionGroundedPlan.phases
    .map(
      (phase) =>
        /\b(?:details?|preview)\s+of\s+(?:the\s+)?(.+)$/iu.exec(phase.title)?.[1]?.trim() ??
        /^preview\s+(?:the\s+)?(.+)$/iu.exec(phase.title)?.[1]?.trim()
    )
    .find(
      (value): value is string =>
        typeof value === 'string' &&
        value.length > 0 &&
        !/^(?:selected|current)\b/iu.test(value)
    )
  const previewRequested = /\bpreview\b/iu.test(goal)
  let previewSplit = false
  const previewPhases = selectionGroundedPlan.phases.flatMap((phase) => {
    if (!previewRequested || !/\bpreview\b/iu.test(phase.title)) {
      return [phase]
    }
    const selectedItem =
      /\bselect\s+(?:the\s+)?(.+?)(?:\s+from\b|\s+to\b|\s+in\b|$)/iu.exec(
        phase.title
      )?.[1]?.trim() ?? previewTarget ?? explicitPreviewTarget
    if (!selectedItem) return [phase]
    previewSplit = true
    return [
      { ...phase, title: `Find and select ${selectedItem}` },
      {
        id: `${phase.id}-preview`,
        title: `Open the separate preview window or Quick Look view for ${selectedItem}`
      }
    ]
  })
  const groundedPlan =
    previewRequested && !previewSplit
      ? {
          ...selectionGroundedPlan,
          phases: selectionGroundedPlan.phases.map((phase) =>
            /\bpreview\b/iu.test(phase.title) && previewTarget
              ? {
                  ...phase,
                  title: `Open the separate preview window or Quick Look view for ${previewTarget}`
                }
              : phase
          )
        }
      : normalizeTaskExecutionPlan({ phases: previewPhases }) ?? selectionGroundedPlan
  const outcomePhases = groundedPlan.phases.filter(
    (phase, index) =>
      index === 0 ||
      !(
        /^confirm\b/iu.test(phase.title) &&
        /\b(?:clicking|pressing|selecting)\s+(?:the\s+)?(?:apply|confirm|done|ok|save)\b/iu.test(
          phase.title
        )
      )
  )
  const selectedLabels = new Set<string>()
  const distinctSelectionPhases = outcomePhases.filter((phase) => {
    const label = /\bselect\s+(?:the\s+)?(.+?)(?:\s+from\b|\s+to\b|\s+in\b|$)/iu.exec(
      phase.title
    )?.[1]
    if (!label) return true
    const normalizedLabel = label.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
    if (selectedLabels.has(normalizedLabel)) return false
    selectedLabels.add(normalizedLabel)
    return true
  })
  const distinctGroundedPlan =
    normalizeTaskExecutionPlan({ phases: distinctSelectionPhases }) ?? groundedPlan
  const separatedSearchPhases = distinctGroundedPlan.phases.flatMap((phase) => {
    const combinedResult =
      /^(?:search|find)(?:\s+for)?\s+and\s+(?:locate|open|select)(?:\s+to)?\s+(.+)$/iu.exec(
        phase.title
      )?.[1]?.trim()
    if (!combinedResult) return [phase]
    return [
      { ...phase, title: `Search for ${combinedResult}` },
      {
        id: `${phase.id}-result`,
        title: `Select ${combinedResult} from the matching results and show its destination or details`
      }
    ]
  })
  const resultSeparatedPlan =
    normalizeTaskExecutionPlan({ phases: separatedSearchPhases }) ?? distinctGroundedPlan
  const requestsSearchThenResult =
    /\b(?:find|search)\b[^.!?]{0,120}\b(?:locate|open|select)\b/iu.test(goal)
  const hasResultOutcome = resultSeparatedPlan.phases.some(
    (phase) =>
      /\b(?:locate|open|select|show)\b/iu.test(phase.title) &&
      !/\b(?:search field|search box|search bar)\b/iu.test(phase.title)
  )
  const resultGroundedPlan =
    requestsSearchThenResult && !hasResultOutcome
      ? normalizeTaskExecutionPlan({
          phases: [
            ...resultSeparatedPlan.phases,
            'Select the requested matching result and show its destination or details'
          ]
        }) ?? resultSeparatedPlan
      : resultSeparatedPlan
  const activeScope = currentScopedLabel(currentState)
  if (!activeScope || new RegExp(`\\b${activeScope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'iu').test(goal)) {
    return resultGroundedPlan
  }
  const userRequestedScope =
    /\b(?:filter|category|scope)\b/iu.test(goal) ||
    /\b(?:filter|limit|narrow|restrict)\b[^.!?]{0,80}\b(?:by|to)\b/iu.test(goal)
  if (userRequestedScope) return resultGroundedPlan

  const visibleSearch = /AX(?:SearchField|TextField)[^\n]*(?:"Search"|search)/iu.test(
    currentState ?? ''
  )
  let replaced = false
  const phases = resultGroundedPlan.phases.flatMap((groundedPhase) => {
    const scopeOperation =
      /\b(?:filter|category|scope)\b/iu.test(groundedPhase.title) &&
      /\b(?:change|choose|clear|remove|select|set|switch)\b/iu.test(groundedPhase.title)
    if (!scopeOperation || replaced) {
      if (
        visibleSearch &&
        /\b(?:find|locate|search)\b/iu.test(goal) &&
        /^select\b/iu.test(groundedPhase.title)
      ) {
        return [{ ...groundedPhase, title: `Find and ${groundedPhase.title.replace(/^select\b/iu, 'select')}` }]
      }
      return [groundedPhase]
    }
    replaced = true
    return [{ ...groundedPhase, title: 'Remove the unrelated active filter, category, or scope' }]
  })
  const groundedPhases = replaced
    ? phases
    : [
        {
          id: 'phase-scope-reset',
          title: 'Remove the unrelated active filter, category, or scope'
        },
        ...phases
      ]
  return normalizeTaskExecutionPlan({ phases: groundedPhases }) ?? resultGroundedPlan
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
    'Use one phase when the task has one visible outcome. Add phases only for distinct prerequisite states.',
    'Stop at the exact outcome the user requested. Do not add later use, demonstration, interaction, or content that the user did not request.',
    'Make every phase a distinct, non-overlapping outcome. A phase must not repeat, contain, or depend on work assigned to a later phase.',
    'Include every required user detail in exactly one phase, after its prerequisites and before any phase that uses its result.',
    'Separate object descriptions from requested operations. An item\'s type, language, origin, format, or other descriptive attribute is identification context, not a request to change a filter, mode, or category.',
    'Add a filter, mode, view, or category phase only when the user explicitly requests that state or it is required by the visible interface to reach the requested result.',
    'If the current interface has an unrelated active filter, category, or scope, remove that restriction before locating the requested item.',
    'For item tasks, locate and select the exact requested item before any phase that previews it, opens its details, or changes its presentation view.',
    ...surfaceRules,
    'Keep the plan compact. Do not add a separate verification, reporting, or summary phase; the agent verifies each visible outcome while it works.',
    'Name the visible result that completes the final phase. Do not use a generic phase such as "Complete the requested work" or "Verify the result".',
    'Use short, specific titles such as "Clear the search field", "Type AAPL", "Select AAPL", or "Show the AAPL details".',
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
          minItems: 1,
          maxItems: 4,
          items: { type: 'string' }
        }
      },
      required: ['phases']
    }
  }
} as const
