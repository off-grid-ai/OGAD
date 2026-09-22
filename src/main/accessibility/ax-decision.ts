import type { OptionDecision } from '../llm'
import type { AxSnapshot } from './ax-elements'
import type { ElementStep } from './ax-agent'
import type { ComputerUseDecisionResult, DecisionFamily, ProbabilityDistribution } from './ax-state'
import type { TaskExecutionPhase } from '../../shared/task-execution-plan'

const MAX_OPTIONS = 10

export interface DecisionCandidate {
  description: string
  coarseLabel?: string
  step: ElementStep
  targetIndex?: number
  region?: string
  roleGroup?: string
}

function compactCandidateText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`
}

export type ActionFamily =
  | 'activate_target'
  | 'scroll_view'
  | 'type_text'
  | 'press_key'
  | 'propose_completion'
  | 'no_structured_action'
  | 'no_valid_action'

export interface FactorizedElementDecision {
  step: ElementStep
  result: ComputerUseDecisionResult
  writerTargetIndex?: number
}

export type ScoreOptions = (
  context: string,
  question: string,
  options: readonly string[]
) => Promise<OptionDecision>

const DECISION_THRESHOLD: Readonly<Record<DecisionFamily, number>> = {
  action_kind: 0.55,
  target_group: 0.5,
  target: 0.58,
  completion: 0.85,
  user_handoff: 0.6,
  visual_recovery: 0.5
}

function isEditable(element: AxSnapshot['elements'][number]): boolean {
  return /TextField|TextArea|SearchField|Edit|Document|ComboBox/i.test(element.role)
}

function isActionTarget(element: AxSnapshot['elements'][number]): boolean {
  return !/(?:Dialog|Window|Group|List|Menu|TabList|TabPanel|Tree|Slider|Stepper|Incrementor|ValueIndicator)$/i.test(
    element.role
  )
}

function currentIntent(context: string): string {
  return (
    /^Current milestone:\s*(.+)$/imu.exec(context)?.[1]?.trim() ??
    context.split('\nCurrent observation items', 1)[0]!
  )
    .replace(/\s+/gu, ' ')
    .trim()
}

function positiveTextIntent(context: string): boolean {
  return /\b(?:enter|fill|type|write)\b|\b(?:find|locate|look|search)(?:\s+for)?\b|\b(?:open|navigate|go)\b[^.!?]{0,80}\b(?:https?:\/\/|www\.)/iu.test(
    currentIntent(context)
  )
}

function relationalTargetIntent(context: string): boolean {
  const intent = currentIntent(context)
  return (
    /\b(?:\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b[^.!?]{0,80}\b(?:result|item|entry|row|column|option|link|button|checkbox|shape)\b/iu.test(
      intent
    ) ||
    /\b(?:left|right|above|below|nearest|closest|farthest|matching|corresponding)\b[^.!?]{0,80}\b(?:item|entry|row|column|control|link|button|checkbox|shape)\b/iu.test(
      intent
    )
  )
}

const GENERIC_CONTROL_LABEL =
  /^(?:like|reply|comment|share|save|follow|more|menu|options|open|view|edit|delete)(?:\s+\d+)?$/iu

function nearbyVisibleContext(
  target: AxSnapshot['elements'][number],
  snapshot: AxSnapshot
): string {
  const label = (target.name || target.value).trim()
  if (!GENERIC_CONTROL_LABEL.test(label)) return ''

  let nearest: { text: string; distance: number } | undefined
  for (const element of snapshot.elements) {
    if (element.executable !== false || element.enabled === false) continue
    if (target.region && element.region && target.region !== element.region) continue
    const text = compactCandidateText(element.name || element.value, 64)
    if (!text || text.toLocaleLowerCase() === label.toLocaleLowerCase()) continue
    const horizontalDistance = Math.abs(element.cx - target.cx)
    const verticalDistance = Math.abs(element.cy - target.cy)
    if (horizontalDistance > 360 || verticalDistance > 120) continue
    const distance = horizontalDistance + verticalDistance * 3
    if (!nearest || distance < nearest.distance) nearest = { text, distance }
  }
  return nearest ? ` near visible text ${JSON.stringify(nearest.text)}` : ''
}

function elementState(element: AxSnapshot['elements'][number]): string {
  const toggleEffect =
    typeof element.checked === 'boolean' && /CheckBox|Switch|Toggle/i.test(element.role)
      ? `activating sets checked=${!element.checked}`
      : typeof element.selected === 'boolean' && /RadioButton|Option|Tab/i.test(element.role)
        ? element.selected
          ? 'already selected; activating keeps it selected'
          : 'activating sets selected=true'
        : ''
  return [
    typeof element.checked === 'boolean' ? `checked=${element.checked}` : '',
    typeof element.selected === 'boolean' ? `selected=${element.selected}` : '',
    toggleEffect,
    element.value ? `value=${JSON.stringify(element.value)}` : '',
    element.focused ? 'focused=true' : ''
  ]
    .filter(Boolean)
    .join(' ')
}

function activationStep(element: AxSnapshot['elements'][number]): ElementStep {
  if (element.hasPopup && element.role !== 'AXMenuBarItem') {
    return { action: 'hover', index: element.index }
  }
  return element.actionable
    ? { action: 'press', index: element.index }
    : { action: 'click', index: element.index }
}

function phaseCompletionSatisfied(
  phase: TaskExecutionPhase | undefined,
  snapshot: AxSnapshot
): boolean {
  const completion = phase?.completion
  if (!completion) return false
  const editors = snapshot.elements.filter(
    (element) => element.enabled && element.executable !== false && isEditable(element)
  )
  if (completion.kind === 'field_empty') {
    return editors.length === 1 && !editors[0]!.value.trim()
  }
  if (completion.kind === 'field_value') {
    const expected = completion.value.replace(/\s+/gu, ' ').trim().toLocaleLowerCase()
    return editors.some(
      (element) => element.value.replace(/\s+/gu, ' ').trim().toLocaleLowerCase() === expected
    )
  }
  // Identity completion is a semantic judgment. Do not assemble proof from
  // labels scattered across the screen. The decision model evaluates identity
  // only after this phase has executed an action and received a fresh frame.
  return false
}

export function elementDecisionCandidates(snapshot: AxSnapshot): DecisionCandidate[] {
  const elements = snapshot.elements.filter(
    (element) => element.enabled && element.executable !== false && isActionTarget(element)
  )
  return [
    ...elements.map((element) => {
      const label = compactCandidateText(element.name || element.value || 'unnamed', 72)
      const description = `${element.hasPopup ? 'Open submenu from' : 'Activate'} control [${element.index}] ${element.role} ${JSON.stringify(label)}${element.region ? ` in the ${element.region} region` : ''}${elementState(element) ? ` ${elementState(element)}` : ''}${nearbyVisibleContext(element, snapshot)}`
      return {
        description: compactCandidateText(description, 160),
        coarseLabel: `${element.role.replace(/^AX/u, '')} ${JSON.stringify(label)}`,
        step: activationStep(element),
        targetIndex: element.index,
        region: element.region ?? 'unknown-region',
        roleGroup: /TextField|TextArea|SearchField|Edit|Document|ComboBox/i.test(element.role)
          ? 'editable fields'
          : /Button|Link|MenuItem|RadioButton|CheckBox/i.test(element.role)
            ? 'action controls'
            : 'other controls'
      }
    }),
    {
      description: 'Press Enter to submit the current focused value',
      step: { action: 'key', keys: 'Enter' }
    },
    {
      description: 'The task is visibly complete',
      step: { action: 'done', summary: 'The requested change is visible.' }
    },
    {
      description: 'The next step needs private user input',
      step: { action: 'human_required', why: 'Private input is required.' }
    },
    {
      description: 'Use the visual specialist because text entry or a visual target is required',
      step: { action: 'vision_required', why: 'The next step needs the visual specialist.' }
    }
  ]
}

function groupDescription(candidates: readonly DecisionCandidate[]): string {
  const region = new Set(candidates.map((candidate) => candidate.region).filter(Boolean))
  const roles = new Set(candidates.map((candidate) => candidate.roleGroup).filter(Boolean))
  const heading = [
    region.size === 1 ? [...region][0] : undefined,
    roles.size === 1 ? [...roles][0] : undefined
  ]
    .filter(Boolean)
    .join(' ')
  return `${heading ? `${heading}: ` : ''}${candidates
    .map((candidate) => candidate.coarseLabel ?? candidate.description)
    .join('; ')}`
}

function partitionCandidates(
  candidates: readonly DecisionCandidate[],
  key: (candidate: DecisionCandidate) => string | undefined
): DecisionCandidate[][] {
  const groups = new Map<string, DecisionCandidate[]>()
  for (const candidate of candidates) {
    const value = key(candidate) ?? 'other'
    const group = groups.get(value) ?? []
    group.push(candidate)
    groups.set(value, group)
  }
  return [...groups.values()]
}

/** Keep targets together by their observed region or accessibility role. Every
 * candidate remains reachable without inferring intent from task text. */
function decisionGroups(candidates: readonly DecisionCandidate[]): DecisionCandidate[][] {
  const byRegion = partitionCandidates(candidates, (candidate) => candidate.region)
  if (byRegion.length > 1 && byRegion.length <= MAX_OPTIONS) return byRegion
  const byRole = partitionCandidates(candidates, (candidate) => candidate.roleGroup)
  if (byRole.length > 1 && byRole.length <= MAX_OPTIONS) return byRole
  const groupSize = Math.ceil(candidates.length / MAX_OPTIONS)
  const groups: DecisionCandidate[][] = []
  for (let index = 0; index < candidates.length; index += groupSize) {
    groups.push(candidates.slice(index, index + groupSize))
  }
  return groups
}

function distribution(
  labels: readonly string[],
  decision: OptionDecision
): ProbabilityDistribution {
  return { labels: [...labels], probabilities: [...decision.probabilities] }
}

function metrics(probabilities: readonly number[]): {
  top: number
  margin: number
  entropy: number
} {
  const sorted = [...probabilities].sort((a, b) => b - a)
  const top = sorted[0] ?? 0
  const margin = top - (sorted[1] ?? 0)
  const entropy = probabilities.reduce(
    (sum, probability) => sum - (probability > 0 ? probability * Math.log2(probability) : 0),
    0
  )
  return { top, margin, entropy }
}

function keyboardDecisionCandidates(snapshot: AxSnapshot): DecisionCandidate[] {
  const focusedEditable = snapshot.elements.some(
    (element) => element.enabled && element.focused === true && isEditable(element)
  )
  const dialogOpen = snapshot.elements.some((element) => /Dialog/i.test(element.role))
  return [
    ...(focusedEditable
      ? [
          {
            description: 'Press Enter to submit or confirm the focused value.',
            step: { action: 'key', keys: 'Enter' } as const
          },
          {
            description: 'Press Tab to move focus from the current editable field.',
            step: { action: 'key', keys: 'Tab' } as const
          }
        ]
      : []),
    ...(dialogOpen
      ? [
          {
            description: 'Press Escape to close the current dialog.',
            step: { action: 'key', keys: 'Escape' } as const
          }
        ]
      : [])
  ]
}

/** Build a small set of reversible scroll choices from the visible regions.
 * The chosen element only anchors the pointer inside that region; it is not
 * activated. This lets structured control reveal off-screen list or sidebar
 * items without handing the whole task to vision. */
function scrollDecisionCandidates(snapshot: AxSnapshot): DecisionCandidate[] {
  const byRegion = new Map<string, AxSnapshot['elements']>()
  for (const element of snapshot.elements) {
    if (!element.enabled || /MenuBarItem|MenuItem/i.test(element.role)) continue
    const region = element.region ?? 'center'
    const group = byRegion.get(region) ?? []
    group.push(element)
    byRegion.set(region, group)
  }
  return [...byRegion.entries()]
    .filter(([, elements]) => elements.length >= 2)
    .sort((left, right) => right[1].length - left[1].length)
    .slice(0, 4)
    .flatMap(([region, elements]) => {
      const anchor =
        elements.find((element) => element.selected) ?? elements[Math.floor(elements.length / 2)]!
      const labels = elements
        .map((element) => element.name || element.value)
        .filter(Boolean)
        .slice(0, 4)
        .join(', ')
      return (['up', 'down'] as const).map((direction) => ({
        description: compactCandidateText(
          `Scroll ${direction} in the ${region} region${labels ? ` containing ${labels}` : ''}.`,
          160
        ),
        step: { action: 'scroll', index: anchor.index, direction } as const,
        region,
        roleGroup: 'scrollable view'
      }))
    })
}

function actionFamilyCandidates(
  snapshot: AxSnapshot,
  context: string,
  allowCompletion = true,
  textEntryAvailable = false,
  excludedFamilies: ReadonlySet<ActionFamily> = new Set()
): Array<{ family: ActionFamily; description: string }> {
  const candidates: Array<{ family: ActionFamily; description: string }> = []
  const executable = snapshot.elements.filter(
    (element) => element.enabled && element.executable !== false && isActionTarget(element)
  )
  const editable = executable.filter(isEditable)
  const activatable = executable.filter((element) => !isEditable(element))
  if (activatable.length > 0 && !excludedFamilies.has('activate_target')) {
    candidates.push({
      family: 'activate_target',
      description: `Activate one visible non-editable control only if its current action advances rather than reverses the planned result. ${activatable.length} controls are available; the exact target is chosen next.`
    })
  }
  if (
    scrollDecisionCandidates(snapshot).length > 0 &&
    /\b(?:browse|clear|find|locate|remove|reveal|scroll|search|select|show)\b/iu.test(
      currentIntent(context)
    ) &&
    !excludedFamilies.has('scroll_view')
  ) {
    candidates.push({
      family: 'scroll_view',
      description: 'Scroll one visible region to reveal an off-screen control or item.'
    })
  }
  if (editable.length > 0 && textEntryAvailable && !excludedFamilies.has('type_text')) {
    candidates.push({
      family: 'type_text',
      description: `Write the exact value supplied by the active plan into one visible editable field. ${editable.length} fields are available; the exact field is chosen in the next decision.`
    })
  }
  if (keyboardDecisionCandidates(snapshot).length > 0 && !excludedFamilies.has('press_key')) {
    candidates.push({
      family: 'press_key',
      description: 'Use a keyboard command whose focus or dialog precondition is visible.'
    })
  }
  if (
    allowCompletion &&
    /verification satisfied/iu.test(context) &&
    !excludedFamilies.has('propose_completion')
  ) {
    candidates.push({
      family: 'propose_completion',
      description:
        'Check whether current control state proves the planned result is already active, including when activation would reverse or undo that result.'
    })
  }
  if (candidates.length === 0 && !excludedFamilies.has('no_structured_action')) {
    candidates.push({
      family: 'no_structured_action',
      description: 'No listed structured action family can safely advance the current milestone.'
    })
  }
  return candidates
}

function hasStructurallyProtectedInput(snapshot: AxSnapshot): boolean {
  return snapshot.elements.some(
    (element) =>
      element.enabled &&
      element.executable !== false &&
      (element.role === 'AXSecureTextField' ||
        element.risk === 'private' ||
        element.risk === 'authentication' ||
        element.risk === 'payment')
  )
}

function noCandidateResult(startedAt: number, now: () => number): FactorizedElementDecision {
  return {
    step: {
      action: 'vision_required',
      why: 'No executable structured candidate is available.'
    },
    result: {
      family: 'visual_recovery',
      distributions: [],
      topProbability: 1,
      probabilityMargin: 1,
      entropy: 0,
      combinedConfidence: 1,
      backend: 'rules',
      abstentionReason: 'no_executable_candidate',
      latencyMs: now() - startedAt
    }
  }
}

export async function chooseFactorizedElementStep(
  context: string,
  snapshot: AxSnapshot,
  score: ScoreOptions,
  phase?: TaskExecutionPhase,
  allowCompletion = true,
  now: () => number = Date.now,
  excludedFamilies: ReadonlySet<ActionFamily> = new Set()
): Promise<FactorizedElementDecision> {
  const startedAt = now()
  const distributions: ProbabilityDistribution[] = []
  if (allowCompletion && phaseCompletionSatisfied(phase, snapshot)) {
    return {
      step: {
        action: 'milestone_complete',
        summary: 'The phase completion condition is visible.'
      },
      result: {
        family: 'completion',
        distributions: [],
        topProbability: 1,
        probabilityMargin: 1,
        entropy: 0,
        combinedConfidence: 1,
        backend: 'rules',
        latencyMs: now() - startedAt
      }
    }
  }
  if (!snapshot.elements.some((element) => element.enabled && element.executable !== false)) {
    return noCandidateResult(startedAt, now)
  }
  const emptyEditors = snapshot.elements.filter(
    (element) =>
      element.enabled &&
      element.executable !== false &&
      isEditable(element) &&
      !element.value.trim()
  )
  if (emptyEditors.length === 1 && positiveTextIntent(context)) {
    return {
      step: { action: 'vision_required', why: 'A bounded free-text writer is required.' },
      writerTargetIndex: emptyEditors[0]!.index,
      result: {
        family: 'action_kind',
        distributions: [],
        topProbability: 1,
        probabilityMargin: 1,
        entropy: 0,
        combinedConfidence: 1,
        backend: 'rules',
        latencyMs: now() - startedAt
      }
    }
  }
  if (relationalTargetIntent(context)) {
    return {
      step: {
        action: 'vision_required',
        why: 'The target depends on a relative position or relationship.'
      },
      result: {
        family: 'visual_recovery',
        distributions: [],
        topProbability: 1,
        probabilityMargin: 1,
        entropy: 0,
        combinedConfidence: 1,
        backend: 'rules',
        latencyMs: now() - startedAt
      }
    }
  }
  const families = actionFamilyCandidates(
    snapshot,
    context,
    allowCompletion,
    phase?.operation === undefined || phase.operation.value !== undefined,
    excludedFamilies
  )
  if (families.length === 0) return noCandidateResult(startedAt, now)
  const familyDecision =
    families.length === 1
      ? { choice: 0, confidence: 1, probabilities: [1] }
      : await score(
          context,
          'Using the active intent and current AX state in Context, which action family advances the current milestone now?',
          families.map((candidate) => candidate.description)
        )
  if (families.length > 1) {
    distributions.push(
      distribution(
        families.map((candidate) => candidate.family),
        familyDecision
      )
    )
  }
  const selectedFamily = families[familyDecision.choice]?.family ?? 'no_valid_action'
  let combinedConfidence = familyDecision.confidence
  let selectedStep: ElementStep
  let writerTargetIndex: number | undefined
  const chooseCandidate = async (
    initialCandidates: DecisionCandidate[],
    groupQuestion: string,
    targetQuestion: string
  ): Promise<DecisionCandidate | undefined> => {
    let candidates = initialCandidates
    while (candidates.length > MAX_OPTIONS) {
      const groups = decisionGroups(candidates)
      const groupDecision = await score(context, groupQuestion, groups.map(groupDescription))
      distributions.push(distribution(groups.map(groupDescription), groupDecision))
      combinedConfidence *= groupDecision.confidence
      candidates = groups[groupDecision.choice] ?? []
    }
    if (candidates.length < 2) {
      return candidates[0]
    }
    const targetDecision = await score(
      context,
      targetQuestion,
      candidates.map((candidate) => candidate.description)
    )
    distributions.push(
      distribution(
        candidates.map((candidate) => candidate.description),
        targetDecision
      )
    )
    combinedConfidence *= targetDecision.confidence
    return candidates[targetDecision.choice]
  }
  if (selectedFamily === 'activate_target') {
    const selected = await chooseCandidate(
      elementDecisionCandidates(snapshot).filter((candidate) => {
        const step = candidate.step
        if (step.action !== 'click' && step.action !== 'hover' && step.action !== 'press') {
          return false
        }
        const element = snapshot.elements.find((item) => item.index === step.index)
        return Boolean(element && !isEditable(element))
      }),
      'Which target group contains the control that best matches the planned operation target in Context?',
      'Which single listed control performs the planned operation without reversing or undoing the planned result?'
    )
    selectedStep =
      selected?.step ??
      ({ action: 'vision_required', why: 'No safe structured target was selected.' } as const)
  } else if (selectedFamily === 'scroll_view') {
    const selected = await chooseCandidate(
      scrollDecisionCandidates(snapshot),
      'Which visible region must move to reveal the required off-screen control or item?',
      'Which direction must that region scroll?'
    )
    selectedStep =
      selected?.step ??
      ({ action: 'vision_required', why: 'No safe structured scroll was selected.' } as const)
  } else if (selectedFamily === 'type_text') {
    const selected = await chooseCandidate(
      snapshot.elements
        .filter((element) => element.enabled && element.executable !== false && isEditable(element))
        .map((element) => ({
          description: compactCandidateText(
            `Write into field [${element.index}] ${element.role} ${JSON.stringify(element.name || 'unnamed')}${element.focused === true ? ' focused=true' : ''}`,
            160
          ),
          targetIndex: element.index,
          step: {
            action: 'vision_required',
            why: 'A bounded free-text writer is required.'
          } as const
        })),
      'Which structural group contains the editable field that best matches the planned operation target?',
      'Which listed field best matches the planned operation target and must receive its value?'
    )
    writerTargetIndex = selected?.targetIndex
    selectedStep =
      selected?.step ??
      ({ action: 'vision_required', why: 'No editable field was selected.' } as const)
  } else if (selectedFamily === 'press_key') {
    const selected = await chooseCandidate(
      keyboardDecisionCandidates(snapshot),
      'Which keyboard-command group contains the required command?',
      'Which single keyboard command is required next?'
    )
    selectedStep =
      selected?.step ??
      ({ action: 'vision_required', why: 'No safe keyboard command was selected.' } as const)
  } else if (selectedFamily === 'propose_completion') {
    const completion = await score(context, 'Does fresh evidence prove the current milestone?', [
      'No. The planned result is not active; continue the current milestone.',
      'Yes. The planned result is active; do not activate a control that would reverse or undo it.'
    ])
    distributions.push(distribution(['continue', 'complete'], completion))
    combinedConfidence *= completion.confidence
    if (completion.choice !== 1) {
      return chooseFactorizedElementStep(
        context,
        snapshot,
        score,
        phase,
        false,
        now,
        excludedFamilies
      )
    }
    selectedStep = {
      action: 'milestone_complete',
      summary: 'The current milestone is visibly complete.'
    }
  } else if (selectedFamily === 'no_structured_action') {
    const protectedInput = hasStructurallyProtectedInput(snapshot)
    const fallbackOptions = [
      'Wait because the visible interface is currently changing.',
      ...(protectedInput
        ? [
            'Hand control to the user because a structurally secure or high-risk input field is visible.'
          ]
        : []),
      'Use visual recovery because the required target or state is not available in the structured controls.'
    ]
    const fallback = await score(
      context,
      'No structured action family was selected. What evidence-backed fallback is required now?',
      fallbackOptions
    )
    distributions.push(distribution(fallbackOptions, fallback))
    combinedConfidence *= fallback.confidence
    if (fallback.choice === 0) {
      selectedStep = { action: 'wait', durationMs: 250 }
    } else if (protectedInput && fallback.choice === 1) {
      selectedStep = { action: 'human_required', why: 'Private or high-risk input is required.' }
    } else {
      selectedStep = {
        action: 'vision_required',
        why: 'The structured controls are insufficient for the required action.'
      }
    }
  } else {
    selectedStep = {
      action: 'vision_required',
      why: 'No safe structured action is available.'
    }
  }
  combinedConfidence = Math.pow(combinedConfidence, 1 / Math.max(1, distributions.length))
  const levelMetrics = distributions.map((item) => metrics(item.probabilities))
  const summary = {
    top: levelMetrics.at(-1)?.top ?? 1,
    margin: levelMetrics.length ? Math.min(...levelMetrics.map((item) => item.margin)) : 1,
    entropy: levelMetrics.reduce((sum, item) => sum + item.entropy, 0)
  }
  const family: DecisionFamily =
    selectedFamily === 'propose_completion'
      ? 'completion'
      : selectedStep.action === 'human_required'
        ? 'user_handoff'
        : selectedStep.action === 'vision_required'
          ? 'visual_recovery'
          : 'action_kind'
  const threshold = DECISION_THRESHOLD[family]
  const abstain = combinedConfidence < threshold
  return {
    step: abstain
      ? {
          action: 'vision_required',
          why: `Decision confidence ${combinedConfidence.toFixed(3)} is below ${threshold.toFixed(3)}.`
        }
      : selectedStep,
    result: {
      family,
      distributions,
      topProbability: summary.top,
      probabilityMargin: summary.margin,
      entropy: summary.entropy,
      combinedConfidence,
      backend: 'decider',
      ...(abstain ? { abstentionReason: 'confidence_below_family_threshold' } : {}),
      latencyMs: now() - startedAt
    },
    ...(writerTargetIndex !== undefined ? { writerTargetIndex } : {})
  }
}

/** Keep every model call within the model's trained A-J option head. Large AX
 * trees are narrowed through bounded groups, then scored again inside the
 * selected group. */
export async function chooseElementStep(
  context: string,
  snapshot: AxSnapshot,
  score: ScoreOptions
): Promise<{ step: ElementStep; confidence: number }> {
  const decision = await chooseFactorizedElementStep(context, snapshot, score)
  return { step: decision.step, confidence: decision.result.combinedConfidence }
}

export function serializeElementStep(step: ElementStep): string {
  return JSON.stringify(step)
}
