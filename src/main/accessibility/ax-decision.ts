import type { OptionDecision } from '../llm'
import type { AxSnapshot } from './ax-elements'
import type { ElementStep } from './ax-agent'
import type { ComputerUseDecisionResult, DecisionFamily, ProbabilityDistribution } from './ax-state'
import type { TaskExecutionPhase } from '../../shared/task-execution-plan'
import { deterministicWriterLiteral } from './ax-writer'

const MAX_OPTIONS = 10

export interface DecisionCandidate {
  description: string
  step: ElementStep
  region?: string
  roleGroup?: string
}

export type ActionFamily =
  | 'activate_target'
  | 'scroll_view'
  | 'type_text'
  | 'press_key'
  | 'wait'
  | 'propose_completion'
  | 'request_user'
  | 'request_visual_recovery'
  | 'no_valid_action'

export interface FactorizedElementDecision {
  step: ElementStep
  result: ComputerUseDecisionResult
  writerTargetIndex?: number
}

export const DECISION_THRESHOLDS: Readonly<
  Record<
    DecisionFamily,
    Readonly<
      Record<'reversible' | 'private' | 'authentication' | 'payment' | 'destructive', number>
    >
  >
> = {
  action_kind: {
    reversible: 0.55,
    private: 0.9,
    authentication: 0.95,
    payment: 0.98,
    destructive: 0.98
  },
  target_group: {
    reversible: 0.5,
    private: 0.9,
    authentication: 0.95,
    payment: 0.98,
    destructive: 0.98
  },
  target: {
    reversible: 0.58,
    private: 0.92,
    authentication: 0.96,
    payment: 0.99,
    destructive: 0.99
  },
  completion: {
    reversible: 0.85,
    private: 0.95,
    authentication: 0.98,
    payment: 0.99,
    destructive: 0.99
  },
  user_handoff: {
    reversible: 0.6,
    private: 0.7,
    authentication: 0.7,
    payment: 0.7,
    destructive: 0.7
  },
  visual_recovery: {
    reversible: 0.5,
    private: 0.8,
    authentication: 0.9,
    payment: 0.95,
    destructive: 0.95
  }
}

export type ScoreOptions = (
  context: string,
  question: string,
  options: readonly string[]
) => Promise<OptionDecision>

function isEditable(element: AxSnapshot['elements'][number]): boolean {
  return /TextField|TextArea|SearchField|Edit|Document|ComboBox/i.test(element.role)
}

function isActionTarget(element: AxSnapshot['elements'][number]): boolean {
  return !/(?:Dialog|Window|Group|List|Menu|TabList|TabPanel|Tree|Slider|Stepper|Incrementor|ValueIndicator)$/i.test(
    element.role
  )
}

/** Use the operating system's value contract when a milestone requests one
 * unambiguous numeric value that is valid for one visible native slider. */
function nativeSliderValueStep(context: string, snapshot: AxSnapshot): ElementStep | null {
  const intent = currentIntent(context).toLocaleLowerCase()
  if (!/\b(?:adjust|change|choose|decrease|increase|set|turn)\b/iu.test(intent)) return null
  const requestedValues = [...intent.matchAll(/(?<![\p{L}\p{N}.])-?\d+(?:\.\d+)?(?![\p{L}\p{N}.])/gu)]
    .map((match) => Number(match[0]))
    .filter((value) => Number.isFinite(value))
  const uniqueValues = [...new Set(requestedValues)]
  if (uniqueValues.length !== 1) return null
  const targetValue = uniqueValues[0]!
  const sliders = snapshot.elements.filter(
    (element) =>
      element.enabled &&
      element.executable !== false &&
      /Slider/i.test(element.role) &&
      element.valueSettable === true &&
      typeof element.minValue === 'number' &&
      typeof element.maxValue === 'number' &&
      targetValue >= element.minValue &&
      targetValue <= element.maxValue
  )
  if (sliders.length === 0) return null
  const stepFor = (element: AxSnapshot['elements'][number]): ElementStep => {
    const currentValue = Number(element.value.trim())
    return Number.isFinite(currentValue) && currentValue === targetValue
      ? {
          action: 'milestone_complete',
          summary: `The requested slider value ${targetValue} is visible.`
        }
      : { action: 'set_value', index: element.index, value: targetValue }
  }
  if (sliders.length === 1) {
    return stepFor(sliders[0]!)
  }
  const intentWords = new Set(intent.match(/[\p{L}\p{N}]{4,}/gu) ?? [])
  const ranked = sliders
    .map((element) => ({
      element,
      score: (`${element.name} ${element.value}`.toLocaleLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])
        .filter((word) => intentWords.has(word)).length
    }))
    .sort((left, right) => right.score - left.score)
  if (!ranked[0] || ranked[0].score === 0 || ranked[0].score === ranked[1]?.score) return null
  return stepFor(ranked[0].element)
}

/** A slider's position is its value. A generic press or center click selects an
 * arbitrary value, so structured control may observe sliders but must not
 * activate them until the executor has a native set-value operation. */
function sliderNeedsValueAwareGrounding(context: string, snapshot: AxSnapshot): boolean {
  const intent = currentIntent(context).toLocaleLowerCase()
  const sliders = snapshot.elements.filter(
    (element) => element.enabled && element.executable !== false && /Slider/i.test(element.role)
  )
  if (sliders.length === 0) return false
  const requestsValueChange =
    /\b(?:adjust|change|choose|decrease|increase|set|turn)\b/iu.test(intent) ||
    /\b\d+(?:\.\d+)?\b/u.test(intent)
  if (!requestsValueChange) return false
  const intentWords = new Set(intent.match(/[\p{L}\p{N}]{4,}/gu) ?? [])
  return (
    sliders.length === 1 ||
    sliders.some((element) =>
      (`${element.name} ${element.value}`.toLocaleLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).some(
        (word) => intentWords.has(word)
      )
    )
  )
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

function currentIntent(context: string): string {
  const milestone = /^Current milestone:\s*(.+)$/imu.exec(context)?.[1]?.trim()
  if (milestone) return milestone.replace(/\s+/g, ' ')
  return context
    .split('\nCurrent observation items', 1)[0]!
    .split('\nTarget application/window:', 1)[0]!
    .replace(/^(?:Current milestone|Overall task|Current goal|Task):\s*/gim, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function overallTaskIntent(context: string): string {
  return /^Overall task:\s*(.+)$/imu.exec(context)?.[1]?.replace(/\s+/g, ' ').trim() ?? ''
}

/** A plan milestone can describe the state to configure without repeating the
 * navigation command that opens its dialog. When a native menu is open, allow
 * one menu item whose label is explicitly present in the overall task. */
function overallTaskMenuTarget(
  context: string,
  targets: readonly AxSnapshot['elements'][number][],
  snapshot: AxSnapshot
): AxSnapshot['elements'][number] | undefined {
  const overall = overallTaskIntent(context).toLocaleLowerCase()
  if (!overall) return
  const processName = (snapshot.processName ?? '').toLocaleLowerCase().trim()
  const matches = targets.filter((element) => {
    if (!/MenuItem|MenuBarItem/i.test(element.role)) return false
    const label = normalizedLabel(element).replace(/[\s.…]+$/gu, '')
    return label.length >= 3 && label !== processName && containsLabel(overall, label)
  })
  const openMenuItems = matches.filter((element) => /MenuItem/i.test(element.role))
  if (openMenuItems.length === 1) return openMenuItems[0]
  return matches.length === 1 ? matches[0] : undefined
}

/** A native window title is direct state evidence for navigation outcomes such
 * as opening Settings, About, or a named document. Do not treat the ordinary
 * app title as completion: that would make a goal such as "display a result in
 * Calculator" complete merely because Calculator is open. */
function visibleWindowCompletesNavigation(context: string, snapshot: AxSnapshot): boolean {
  const milestone = /^Current milestone:\s*(.+)$/imu.exec(context)?.[1]?.trim() ?? ''
  if (
    !milestone ||
    !/\b(?:activate|bring|confirm|create|display|go|launch|navigate|open|select|show|start|switch|view)\b/iu.test(
      milestone
    )
  ) {
    return false
  }
  const normalize = (value: string): string =>
    value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const app = normalize(snapshot.processName ?? '')
  const title = normalize(snapshot.windowTitle ?? '')
  if (!title) return false
  const normalizedMilestone = normalize(milestone)
  const sourceMatch = /\bfrom\s+(.+?)\s+to\b/iu.exec(normalizedMilestone)
  const source = sourceMatch?.[1]?.trim() ?? ''
  const destination = sourceMatch
    ? normalizedMilestone.slice((sourceMatch.index ?? 0) + sourceMatch[0].length).trim()
    : normalizedMilestone
  const titleWords = title
    .split(' ')
    .filter((word) => word.length >= 4 && !app.split(' ').includes(word))
  if (
    titleWords.some(
      (word) => containsLabel(destination, word) && (!source || !containsLabel(source, word))
    )
  ) {
    return true
  }

  const remainingGoalWords = destination
    .split(' ')
    .filter(
      (word) =>
        word.length >= 3 &&
        !app.split(' ').includes(word) &&
        ![
          'active',
          'and',
          'app',
          'application',
          'bring',
          'condition',
          'confirm',
          'configured',
          'create',
          'display',
          'front',
          'focus',
          'focused',
          'go',
          'launch',
          'main',
          'navigate',
          'new',
          'open',
          'select',
          'show',
          'start',
          'switch',
          'the',
          'to',
          'using',
          'view',
          'window'
        ].includes(word)
    )
  return (title === app || title.startsWith(`${app} `)) && remainingGoalWords.length === 0
}

/** A source named in "switch from X to Y" is evidence that navigation is
 * still required, never that it finished. Structured controls in a modal or
 * secondary window are usually unrelated to Y, so defer to visual recovery
 * instead of selecting one of them. */
function currentWindowIsNavigationSource(context: string, snapshot: AxSnapshot): boolean {
  const milestone = /^Current milestone:\s*(.+)$/imu.exec(context)?.[1]?.trim() ?? ''
  const source = /\bfrom\s+(.+?)\s+to\b/iu.exec(milestone)?.[1]?.trim()
  const title = snapshot.windowTitle.trim()
  return Boolean(source && title && containsLabel(source.toLocaleLowerCase(), title.toLocaleLowerCase()))
}

/** Complete a state-changing milestone only from the requested state itself.
 * A successful click proves that an input changed the interface; it does not
 * prove that the milestone is complete. Native controls expose the stronger
 * evidence as a selected/checked state or as the current value of a picker. */
function visibleStateCompletesMutation(context: string, snapshot: AxSnapshot): boolean {
  const intent = currentIntent(context).toLocaleLowerCase()
  if (!/\b(?:change|choose|disable|enable|select|set|switch|toggle|turn)\b/iu.test(intent)) {
    return false
  }
  const mentions = (value: string): boolean => {
    const normalized = value.toLocaleLowerCase().trim()
    return (
      (normalized.length >= 2 || /^\d+(?:\.\d+)?$/u.test(normalized)) &&
      containsLabel(intent, normalized)
    )
  }

  return snapshot.elements.some((element) => {
    if (!element.enabled) return false
    const label = element.name.trim()
    const value = element.value.trim()
    if (
      element.selected === true &&
      /RadioButton|Option|Tab/i.test(element.role) &&
      (mentions(label) || mentions(value))
    ) {
      return true
    }
    if (/PopUpButton|ComboBox|Slider/i.test(element.role) && value && mentions(value)) return true
    if (typeof element.checked === 'boolean' && mentions(label)) {
      const requestsOff = /\b(?:disable|off|turn off|uncheck)\b/iu.test(intent)
      const requestsOn = /\b(?:enable|on|turn on|check)\b/iu.test(intent)
      return (requestsOff && !element.checked) || (requestsOn && element.checked)
    }
    return false
  })
}

function positiveTextIntent(context: string): boolean {
  const textRequest =
    /\b(?:enter|fill|type|write)\b|\b(?:find|locate|look|search)(?:\s+for)?\b|\b(?:open|navigate|go)\b[^.!?]{0,80}\b(?:https?:\/\/|www\.)/iu
  return currentIntent(context)
    .split(/(?<=[.!?])\s+|\n+/u)
    .some((clause) => {
      const request = textRequest.exec(clause)
      if (!request) return false
      const prefix = clause.slice(Math.max(0, request.index - 100), request.index)
      return !/\b(?:do not|don't|never|no)\b[^.!?]{0,90}$/iu.test(prefix)
    })
}

function visibleInputCompletesMilestone(context: string, snapshot: AxSnapshot): boolean {
  const milestone = /^Current milestone:\s*(.+)$/imu.exec(context)?.[1]?.trim() ?? ''
  if (!milestone) return false
  const inputCommand =
    /\b(?:enter|fill|type|write)\b/iu.test(milestone) ||
    /^(?:use\b[^.!?]{0,100}\bto\s+)?(?:find|locate|look|search)\b/iu.test(milestone)
  if (!inputCommand || !positiveTextIntent(context)) return false
  if (
    /\b(?:and|then)\b[^.!?]{0,100}\b(?:choose|click|open|press|select|submit)\b/iu.test(
      milestone
    )
  ) {
    return false
  }
  const literal = deterministicWriterLiteral({
    milestone,
    field: { role: '', label: '', value: '' },
    nearbyText: [],
    guidance: []
  })
  if (!literal) return false
  const expected = literal.replace(/\s+/gu, ' ').trim()
  return snapshot.elements.some(
    (element) =>
      element.enabled &&
      isEditable(element) &&
      element.value.replace(/\s+/gu, ' ').trim() === expected
  )
}

/** Clear controls are often embedded inside native search fields. When the
 * milestone explicitly asks to clear one visible field, use that local AX
 * relationship instead of asking the Decider to choose among unrelated app
 * controls. */
function clearInputStep(context: string, snapshot: AxSnapshot): ElementStep | undefined {
  const intent = currentIntent(context)
  if (
    !/\b(?:clear|empty|erase|reset|remove)\b[^.!?]{0,80}\b(?:field|input|search|text|value)\b/iu.test(
      intent
    )
  ) {
    return
  }
  const editors = snapshot.elements.filter(
    (element) => element.enabled && element.executable !== false && isEditable(element)
  )
  if (editors.length !== 1) return
  const editor = editors[0]!
  if (!editor.value.trim()) {
    if (positiveTextIntent(context)) return
    return { action: 'milestone_complete', summary: 'The requested field is empty.' }
  }
  const clearControls = snapshot.elements.filter((element) => {
    if (!element.enabled || element.executable === false || !/Button/i.test(element.role)) {
      return false
    }
    if (!/^(?:clear|erase|remove|reset)(?:\s+(?:field|input|search|text|value))?$/iu.test(element.name.trim())) {
      return false
    }
    const elementWidth = element.width ?? 3
    const elementHeight = element.height ?? 3
    const editorWidth = editor.width ?? 3
    const editorHeight = editor.height ?? 3
    const centerX = (element.x ?? element.cx - elementWidth / 2) + elementWidth / 2
    const centerY = (element.y ?? element.cy - elementHeight / 2) + elementHeight / 2
    const editorX = editor.x ?? editor.cx - editorWidth / 2
    const editorY = editor.y ?? editor.cy - editorHeight / 2
    return (
      centerX >= editorX - 16 &&
      centerX <= editorX + editorWidth + 16 &&
      centerY >= editorY - 16 &&
      centerY <= editorY + editorHeight + 16
    )
  })
  return clearControls.length === 1 ? activationStep(clearControls[0]!) : undefined
}

/** A target-app AX tree cannot report a system consent dialog owned by another
 * process, even when that dialog is visibly covering the target. OCR-only text
 * gives us screen-level evidence of that blocker. Hand it to visual recovery
 * before we attempt controls behind the dialog. */
function hasVisibleConsentBlocker(snapshot: AxSnapshot): boolean {
  const visibleText =
    snapshot.visibleText ??
    snapshot.elements
      .filter((element) => element.source === 'ocr')
      .map((element) => element.name || element.value)
      .filter(Boolean)
      .join(' ')
  if (!visibleText) return false
  const hasConsentLanguage =
    /(?:would like|wants) to (?:access|use|send|find|record)|permission|current location/iu.test(
      visibleText
    )
  const hasAllowChoice = /\ballow\b/iu.test(visibleText)
  const hasDenyChoice = /don['’]?t allow|not now|deny/iu.test(visibleText)
  return hasConsentLanguage && hasAllowChoice && hasDenyChoice
}

function privacyPreservingConsentDismissal(
  context: string,
  snapshot: AxSnapshot
): AxSnapshot['elements'][number] | undefined {
  if (!hasVisibleConsentBlocker(snapshot)) return undefined
  const intent = currentIntent(context)
  if (
    /\b(?:allow|approve|grant|enable)\b[^.!?]{0,80}\b(?:access|permission|location|camera|microphone|photos?|contacts?|notifications?)\b|\b(?:location|camera|microphone|photos?|contacts?|notifications?)\b[^.!?]{0,80}\b(?:allow|approve|grant|enable|use)\b/iu.test(
      intent
    )
  ) {
    return undefined
  }
  return snapshot.elements.find(
    (element) =>
      element.source === 'ocr' &&
      /^(?:don['’]?t allow|not now|deny)$/iu.test((element.name || element.value).trim())
  )
}

/** First-run welcome screens hide the controls required by the task. Advancing
 * a plain welcome screen is safe when it does not present an allow/deny choice
 * or ask the user to accept terms. Handle this before ordinary label scoring so
 * verbs such as "view" cannot pull the decision toward an unrelated menu. */
function safeOnboardingAdvance(
  snapshot: AxSnapshot
): AxSnapshot['elements'][number] | undefined {
  if (hasVisibleConsentBlocker(snapshot)) return undefined
  const text = snapshot.elements
    .map((element) => `${element.name} ${element.value}`.trim())
    .filter(Boolean)
    .join(' ')
  if (!/\bwelcome(?:\s+to)?\b/iu.test(text)) return undefined
  if (/\b(?:accept|agree)\b[^.!?]{0,60}\b(?:terms|conditions|policy)\b/iu.test(text)) {
    return undefined
  }
  return snapshot.elements.find(
    (element) =>
      element.enabled &&
      element.executable !== false &&
      /Button/i.test(element.role) &&
      /^(?:continue|get started|start using)$/iu.test(element.name.trim())
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

function normalizedLabel(element: AxSnapshot['elements'][number]): string {
  return (element.name || element.value).toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

function containsLabel(intent: string, label: string): boolean {
  if (label.length < 2) return false
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(intent)
}

const IDENTITY_FILLER_WORDS = new Set([
  'a',
  'an',
  'and',
  'app',
  'application',
  'chart',
  'current',
  'detail',
  'details',
  'display',
  'displayed',
  'for',
  'from',
  'in',
  'into',
  'matching',
  'of',
  'open',
  'page',
  'price',
  'requested',
  'result',
  'results',
  'select',
  'show',
  'stock',
  'the',
  'to',
  'view'
])

function identityTokens(value: string): string[] {
  return (value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (word) => !IDENTITY_FILLER_WORDS.has(word)
  )
}

function identityEvidenceMatches(identity: string, evidence: readonly string[]): boolean {
  const expected = identityTokens(identity)
  if (expected.length === 0) return false
  const visible = new Set(evidence.flatMap(identityTokens))
  return expected.every((word) => visible.has(word))
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
      (element) =>
        element.value.replace(/\s+/gu, ' ').trim().toLocaleLowerCase() === expected
    )
  }
  const identity = completion.value.toLocaleLowerCase().trim()
  if (!identity) return false
  const titleMatches =
    containsLabel(snapshot.windowTitle.toLocaleLowerCase(), identity) ||
    identityEvidenceMatches(identity, [snapshot.windowTitle])
  if (completion.kind === 'selected_identity') {
    return (
      titleMatches ||
      snapshot.elements.some(
        (element) =>
          element.enabled &&
          (element.selected === true || element.checked === true) &&
          (containsLabel(`${element.name} ${element.value}`.toLocaleLowerCase(), identity) ||
            identityEvidenceMatches(identity, [element.name, element.value]))
      )
    )
  }
  const visibleEvidence = snapshot.elements
    .filter((element) => element.enabled && !isEditable(element))
    .flatMap((element) => [element.name, element.value])
  return (
    titleMatches ||
    identityEvidenceMatches(identity, [snapshot.windowTitle, ...visibleEvidence]) ||
    snapshot.elements.some(
      (element) =>
        element.enabled &&
        !isEditable(element) &&
        containsLabel(`${element.name} ${element.value}`.toLocaleLowerCase(), identity)
    )
  )
}

function intentPosition(intent: string, element: AxSnapshot['elements'][number]): number {
  const label = normalizedLabel(element)
  const exact = intent.indexOf(label)
  if (exact >= 0) return exact
  const words = label.match(/[\p{L}\p{N}]{4,}/gu) ?? []
  return words.reduce((earliest, word) => {
    const position = intent.indexOf(word)
    return position >= 0 && (earliest < 0 || position < earliest) ? position : earliest
  }, -1)
}

function exactTargetIntent(context: string, element: AxSnapshot['elements'][number]): boolean {
  const normalizedContext = currentIntent(context).toLocaleLowerCase()
  const label = normalizedLabel(element)
  const labelWords = label.match(/[\p{L}\p{N}]{3,}/gu) ?? []
  const matchesLabel =
    containsLabel(normalizedContext, label) ||
    (labelWords.length >= 2 && labelWords.every((word) => containsLabel(normalizedContext, word)))
  if (!matchesLabel) return false
  const roleRequirements: Array<[RegExp, RegExp]> = [
    [/\bmenu item\b/, /MenuItem/i],
    [/\bcheckbox\b/, /CheckBox/i],
    // Web tabs are often exposed as links or buttons when the page does not
    // provide an ARIA tab role. The exact visible label still binds the target.
    [/\btab\b/, /Tab|Link|Button/i],
    [/\blink\b/, /Link/i],
    [/\b(?:radio|option)\b/, /RadioButton|Option/i],
    [/\bbutton\b/, /Button/i]
  ]
  const requiredRole = roleRequirements.find(([intent]) => intent.test(normalizedContext))
  return (
    !requiredRole || requiredRole[1].test(element.role) || /Generic|Unknown/i.test(element.role)
  )
}

function targetSpecificity(context: string, element: AxSnapshot['elements'][number]): number {
  const intent = currentIntent(context).toLocaleLowerCase()
  const words = normalizedLabel(element).match(/[\p{L}\p{N}]{3,}/gu) ?? []
  return new Set(words.filter((word) => containsLabel(intent, word))).size
}

function directlyRequestedTarget(
  context: string,
  element: AxSnapshot['elements'][number]
): boolean {
  const label = normalizedLabel(element)
  if (!label) return false
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `\\b(?:activate|adjust|change|choose|click|display|enter|expand|launch|navigate|open|press|select|set|show|start|submit|switch|toggle|type|write)\\b(?:\\s+(?:a|an|the|to|new))?\\s+${escaped}(?:$|[^\\p{L}\\p{N}])`,
    'iu'
  ).test(currentIntent(context).toLocaleLowerCase())
}

function mostSpecificExactTargets(
  context: string,
  targets: readonly AxSnapshot['elements'][number][]
): AxSnapshot['elements'][number][] {
  const exact = targets.filter((element) => exactTargetIntent(context, element))
  const maximumSpecificity = exact.reduce(
    (maximum, element) => Math.max(maximum, targetSpecificity(context, element)),
    0
  )
  return exact.filter((element) => targetSpecificity(context, element) === maximumSpecificity)
}

function uniqueExactTarget(
  context: string,
  targets: readonly AxSnapshot['elements'][number][]
): AxSnapshot['elements'][number] | undefined {
  const intent = currentIntent(context)
  const actionDirectives =
    intent.match(
      /\b(?:activate|choose|click|display|enter|expand|fill|launch|navigate|open|press|select|show|submit|toggle|type|write)\b/gi
    ) ??
    []
  const exact = mostSpecificExactTargets(context, targets)
  const normalizedIntent = intent.toLocaleLowerCase()
  if (actionDirectives.length === 1 && exact.length > 0) {
    const ordered = exact
      .map((element) => ({ element, position: intentPosition(normalizedIntent, element) }))
      .filter((entry) => entry.position >= 0)
      .sort(
        (left, right) =>
          left.position - right.position ||
          normalizedLabel(right.element).length - normalizedLabel(left.element).length
      )
    if (ordered.length === 1 || ordered[0]!.position < ordered[1]!.position) {
      return ordered[0]!.element
    }
  }
  if (exact.length !== 1) return
  const targetPosition = intentPosition(normalizedIntent, exact[0]!)
  const earlierStateComplete = targets.some((element) => {
    const position = intentPosition(normalizedIntent, element)
    return (
      position >= 0 &&
      position < targetPosition &&
      (element.checked === true || element.selected === true)
    )
  })
  return earlierStateComplete ? exact[0] : undefined
}

function hierarchicalPathTarget(
  context: string,
  targets: readonly AxSnapshot['elements'][number][]
): AxSnapshot['elements'][number] | undefined {
  const intent = currentIntent(context)
  if (!/[>→]/u.test(intent)) return
  const path = intent
    .split(/[>→]/u)
    .map((part, index) =>
      (index === 0 ? part.replace(/^.*?\b(?:choose|open|select)\b\s*/iu, '') : part)
        .replace(/^[\s"']+|[\s"'.]+$/g, '')
        .replace(/\s+/g, ' ')
        .toLocaleLowerCase()
    )
    .filter(Boolean)
  if (path.length < 2) return
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const matches = targets.filter((element) => normalizedLabel(element) === path[index])
    if (matches.length === 1) return matches[0]
  }
  return undefined
}

function explicitStateProgressTarget(
  context: string,
  targets: readonly AxSnapshot['elements'][number][]
): AxSnapshot['elements'][number] | undefined {
  const intent = currentIntent(context)
  if (/\b(?:uncheck|deselect|turn off|disable|clear the selection)\b/i.test(intent)) return
  const normalizedIntent = intent.toLocaleLowerCase()
  const explicitStateTargets = targets
    .map((element) => ({
      element,
      position: intentPosition(normalizedIntent, element)
    }))
    .filter(
      (entry) =>
        entry.position >= 0 &&
        containsLabel(normalizedIntent, normalizedLabel(entry.element)) &&
        /CheckBox|Switch|Toggle|RadioButton/i.test(entry.element.role) &&
        typeof entry.element.checked === 'boolean'
    )
  if (explicitStateTargets.length === 0) return
  const unfinished = explicitStateTargets
    .filter(({ element }) => !element.checked)
    .sort(
      (left, right) => left.position - right.position || left.element.index - right.element.index
    )
  if (unfinished[0]) return unfinished[0].element

  const finalTargets = targets.filter((element) => {
    if (typeof element.checked === 'boolean') return false
    const label = normalizedLabel(element)
    return label.length >= 2 && containsLabel(normalizedIntent, label)
  })
  return finalTargets.length === 1 ? finalTargets[0] : undefined
}

function orderedIntentTarget(
  context: string,
  targets: readonly AxSnapshot['elements'][number][]
): AxSnapshot['elements'][number] | undefined {
  const intent = currentIntent(context).toLocaleLowerCase()
  const actionCount =
    intent.match(/\b(?:activate|choose|click|expand|open|press|reveal|select|toggle)\b/giu)
      ?.length ?? 0
  const hasOrder = /\b(?:before|after|first|second|then|next)\b/iu.test(intent) || actionCount >= 2
  if (!hasOrder) return

  const ordered = targets
    .map((element) => ({ element, position: intentPosition(intent, element) }))
    .filter(({ element, position }) => position >= 0 && exactTargetIntent(context, element))
    .sort(
      (left, right) => left.position - right.position || left.element.index - right.element.index
    )
  const distinct = ordered.filter(
    (entry, index) =>
      index === 0 || normalizedLabel(entry.element) !== normalizedLabel(ordered[index - 1]!.element)
  )
  if (distinct.length < 2) return

  const lastCompleted = distinct.findLastIndex(
    ({ element }) =>
      element.focused === true || element.checked === true || element.selected === true
  )
  return distinct[Math.min(lastCompleted + 1, distinct.length - 1)]?.element
}

function explicitExpandTarget(
  context: string,
  targets: readonly AxSnapshot['elements'][number][]
): AxSnapshot['elements'][number] | undefined {
  const intent = currentIntent(context).toLocaleLowerCase()
  if (!/\b(?:expand|open|reveal)\b/iu.test(intent)) return
  const matches = targets.filter((element) => {
    if (!/Tab|Disclosure|Button/i.test(element.role) || element.hasPopup) return false
    if (element.selected !== false) return false
    return intentPosition(intent, element) >= 0
  })
  return matches.length === 1 ? matches[0] : undefined
}

export function elementDecisionCandidates(snapshot: AxSnapshot): DecisionCandidate[] {
  const elements = snapshot.elements
    .filter((element) => element.enabled && element.executable !== false && isActionTarget(element))
    .slice(0, 120)
  return [
    ...elements.map((element) => ({
      description: `${element.hasPopup ? 'Open submenu from' : element.actionable ? 'Activate' : 'Click'} control [${element.index}] ${element.role} ${JSON.stringify(element.name || element.value || 'unnamed')}${elementState(element) ? ` ${elementState(element)}` : ''}`,
      step: activationStep(element),
      region: element.region ?? 'unknown-region',
      roleGroup: /TextField|TextArea|SearchField|Edit|Document|ComboBox/i.test(element.role)
        ? 'editable fields'
        : /Button|Link|MenuItem|RadioButton|CheckBox/i.test(element.role)
          ? 'action controls'
          : 'other controls'
    })),
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
  return `${heading ? `${heading}: ` : ''}${candidates.map((candidate) => candidate.description).join('; ')}`
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

/** Keep spatially and semantically related targets together. Sequential
 * chunks made a content control compete through a group headed by unrelated
 * browser chrome. Every candidate remains reachable. */
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

function keyboardDecisionCandidates(snapshot: AxSnapshot, context: string): DecisionCandidate[] {
  const focusedEditable = snapshot.elements.some(
    (element) => element.enabled && element.focused === true && isEditable(element)
  )
  const dialogOpen = snapshot.elements.some((element) => /Dialog/i.test(element.role))
  const escapeRequested =
    /\b(?:press|use|send)\s+(?:the\s+)?escape(?:\s+key)?\b|\bescape\s+key\b/i.test(
      currentIntent(context)
    )
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
    ...(dialogOpen && escapeRequested
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
      const anchor = elements.find((element) => element.selected) ?? elements[Math.floor(elements.length / 2)]!
      const labels = elements
        .map((element) => element.name || element.value)
        .filter(Boolean)
        .slice(0, 4)
        .join(', ')
      return (['up', 'down'] as const).map((direction) => ({
        description: `Scroll ${direction} in the ${region} region${labels ? ` containing ${labels}` : ''}.`,
        step: { action: 'scroll', index: anchor.index, direction } as const,
        region,
        roleGroup: 'scrollable view'
      }))
    })
}

function actionFamilyCandidates(
  snapshot: AxSnapshot,
  context: string
): Array<{ family: ActionFamily; description: string }> {
  const candidates: Array<{ family: ActionFamily; description: string }> = []
  const executable = snapshot.elements.filter(
    (element) => element.enabled && element.executable !== false && isActionTarget(element)
  )
  const editable = executable.filter(isEditable)
  const activatable = executable.filter((element) => !isEditable(element))
  if (activatable.length > 0) {
    candidates.push({
      family: 'activate_target',
      description: `Activate one listed control. This excludes the focused text field. ${activatable.length} targets are available.`
    })
  }
  if (
    scrollDecisionCandidates(snapshot).length > 0 &&
    /\b(?:browse|clear|find|locate|remove|reveal|scroll|search|select|show)\b/iu.test(
      currentIntent(context)
    )
  ) {
    candidates.push({
      family: 'scroll_view',
      description: 'Scroll one visible region to reveal an off-screen control or item.'
    })
  }
  if (
    editable.length > 0 &&
    positiveTextIntent(context) &&
    (editable.some((element) => !element.value.trim()) ||
      /\b(?:replace|change|update|edit|clear)\b/iu.test(currentIntent(context)))
  ) {
    candidates.push({
      family: 'type_text',
      description: `Write free text into one editable field: ${editable
        .map((element) => `[${element.index}] ${element.name || element.role}`)
        .join('; ')}.`
    })
  }
  if (keyboardDecisionCandidates(snapshot, context).length > 0) {
    candidates.push({
      family: 'press_key',
      description: 'Use a keyboard command whose focus or dialog precondition is visible.'
    })
  }
  if (/\bverification satisfied\b/iu.test(context)) {
    candidates.push({
      family: 'propose_completion',
      description: 'Propose completion because the latest exact verification result is satisfied.'
    })
  }
  if (/interface (?:is )?(?:loading|changing)|still loading|in progress/i.test(context)) {
    candidates.push({
      family: 'wait',
      description: 'Wait because the interface is still changing.'
    })
  }
  if (executable.some((element) => (element.risk ?? 'reversible') !== 'reversible')) {
    candidates.push({
      family: 'request_user',
      description: 'Request the user because the next action needs private or high-risk input.'
    })
  }
  return candidates
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
  now: () => number = Date.now
): Promise<FactorizedElementDecision> {
  const startedAt = now()
  const distributions: ProbabilityDistribution[] = []
  const emptyEditors = snapshot.elements.filter(
    (element) =>
      element.enabled &&
      element.executable !== false &&
      isEditable(element) &&
      !element.value.trim()
  )
  const intent = currentIntent(context)
  const explicitTextIntent = positiveTextIntent(context)
  const focusOnlyIntent = /\bfocus\b/iu.test(intent) && !explicitTextIntent
  const consentDismissal = privacyPreservingConsentDismissal(context, snapshot)
  if (consentDismissal) {
    return {
      step: { action: 'click', index: consentDismissal.index },
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
  const onboardingAdvance = safeOnboardingAdvance(snapshot)
  if (onboardingAdvance) {
    return {
      step: { action: 'click', index: onboardingAdvance.index },
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
  if (hasVisibleConsentBlocker(snapshot)) {
    return {
      step: {
        action: 'vision_required',
        why: 'A visible system consent dialog is blocking the target app. Dismiss an unrelated permission request with its privacy-preserving denial action before continuing.'
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
  if (phaseCompletionSatisfied(phase, snapshot)) {
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
  const hasCompletionContract = Boolean(phase?.completion)
  const clearStep = clearInputStep(context, snapshot)
  if (clearStep) {
    return {
      step: clearStep,
      result: {
        family: clearStep.action === 'milestone_complete' ? 'completion' : 'action_kind',
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
  if (!hasCompletionContract && visibleWindowCompletesNavigation(context, snapshot)) {
    return {
      step: {
        action: 'milestone_complete',
        summary: 'The requested window state is visible.'
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
  if (!hasCompletionContract && visibleStateCompletesMutation(context, snapshot)) {
    return {
      step: {
        action: 'milestone_complete',
        summary: 'The requested control state is visible.'
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
  if (!hasCompletionContract && visibleInputCompletesMilestone(context, snapshot)) {
    return {
      step: {
        action: 'milestone_complete',
        summary: 'The requested field value is visible.'
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
  if (currentWindowIsNavigationSource(context, snapshot)) {
    return {
      step: {
        action: 'vision_required',
        why: 'The current window is the source that the milestone must leave.'
      },
      result: {
        family: 'visual_recovery',
        distributions: [],
        topProbability: 1,
        probabilityMargin: 1,
        entropy: 0,
        combinedConfidence: 1,
        backend: 'rules',
        abstentionReason: 'navigation_source_window',
        latencyMs: now() - startedAt
      }
    }
  }
  const sliderValueStep = nativeSliderValueStep(context, snapshot)
  if (sliderValueStep) {
    return {
      step: sliderValueStep,
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
  if (sliderNeedsValueAwareGrounding(context, snapshot)) {
    return {
      step: {
        action: 'vision_required',
        why: 'The requested value is controlled by a slider. Use visual grounding to select the value; do not activate the slider as a generic control.'
      },
      result: {
        family: 'visual_recovery',
        distributions: [],
        topProbability: 1,
        probabilityMargin: 1,
        entropy: 0,
        combinedConfidence: 1,
        backend: 'rules',
        abstentionReason: 'value_aware_control_required',
        latencyMs: now() - startedAt
      }
    }
  }
  if (focusOnlyIntent && emptyEditors.length === 1) {
    return {
      step: { action: 'click', index: emptyEditors[0]!.index },
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
  if (
    /\bremove\b[^.!?]{0,80}\bactive\b[^.!?]{0,80}\b(?:filter|category|scope)\b/iu.test(
      intent
    )
  ) {
    const selected = snapshot.elements.filter(
      (element) => element.enabled && element.selected === true
    )
    const scopedSelections = selected.filter((element) => {
      const label = normalizedLabel(element)
      return label && !/^(?:all|all items|all fonts|everything|unfiltered)$/iu.test(label)
    })
    if (
      scopedSelections.length > 0 &&
      scopedSelections.every((element) =>
        containsLabel(context.toLocaleLowerCase(), normalizedLabel(element))
      )
    ) {
        return {
          step: {
            action: 'milestone_complete',
            summary: 'The active scope is relevant to the overall task.'
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
    if (scopedSelections.length === 1) {
      const scopedSelection = scopedSelections[0]!
      const unrestricted = snapshot.elements.filter(
        (element) =>
          element.enabled &&
          element.executable !== false &&
          element.region === scopedSelection.region &&
          Math.max(
            0,
            Math.min(
              (element.x ?? element.cx) + (element.width ?? 0),
              (scopedSelection.x ?? scopedSelection.cx) + (scopedSelection.width ?? 0)
            ) - Math.max(element.x ?? element.cx, scopedSelection.x ?? scopedSelection.cx)
          ) >
            Math.min(element.width ?? 0, scopedSelection.width ?? 0) * 0.3 &&
          /^(?:all|all items|everything|unfiltered)$/iu.test(
            (element.name || element.value).trim()
          )
      )
      return {
        step:
          unrestricted.length === 1
            ? activationStep(unrestricted[0]!)
            : { action: 'scroll', index: scopedSelection.index, direction: 'up' },
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
  }
  const writerTarget = emptyEditors.length === 1 && explicitTextIntent ? emptyEditors[0] : undefined
  if (writerTarget) {
    return {
      step: { action: 'vision_required', why: 'A bounded free-text writer is required.' },
      writerTargetIndex: writerTarget.index,
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
  const populatedSearch = snapshot.elements.find(
    (element) =>
      element.enabled &&
      isEditable(element) &&
      element.focused === true &&
      Boolean(element.value.trim()) &&
      containsLabel(intent.toLocaleLowerCase(), element.value.toLocaleLowerCase().trim())
  )
  if (
    populatedSearch &&
    /\b(?:display|open|select|show|view)\b/iu.test(intent)
  ) {
    const fieldLeft = populatedSearch.x ?? populatedSearch.cx
    const fieldWidth = populatedSearch.width ?? 0
    const fieldRight = fieldLeft + fieldWidth
    const fieldBottom = (populatedSearch.y ?? populatedSearch.cy) + (populatedSearch.height ?? 0)
    const searchValue = populatedSearch.value.toLocaleLowerCase().trim()
    const matchingResultEvidence = snapshot.elements
      .filter((element) => {
        if (element.source !== 'ocr' || !containsLabel(normalizedLabel(element), searchValue)) {
          return false
        }
        return (
          element.cy >= fieldBottom &&
          element.cx >= fieldLeft &&
          element.cx <= fieldRight
        )
      })
      .sort((a, b) => a.cy - b.cy)
    if (matchingResultEvidence.length > 0) {
      return {
        step: { action: 'click', index: matchingResultEvidence[0]!.index },
        result: {
          family: 'target',
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
    const resultRows = snapshot.elements
      .filter((element) => {
        if (
          !element.enabled ||
          element.executable === false ||
          !/Button|Row|Cell/i.test(element.role) ||
          normalizedLabel(element)
        ) {
          return false
        }
        const left = element.x ?? element.cx
        const width = element.width ?? 0
        const right = left + width
        const top = element.y ?? element.cy
        const height = element.height ?? 0
        const verticalTolerance = Math.max(32, height * 0.5)
        const overlap = Math.max(0, Math.min(fieldRight, right) - Math.max(fieldLeft, left))
        const matchingEvidence = snapshot.elements.some((evidence) => {
          if (evidence.source !== 'ocr') return false
          const label = normalizedLabel(evidence)
          return (
            containsLabel(label, searchValue) &&
            evidence.cx >= left &&
            evidence.cx <= right &&
            evidence.cy >= top - verticalTolerance &&
            evidence.cy <= top + height + verticalTolerance
          )
        })
        return (
          top >= fieldBottom &&
          width >= fieldWidth * 0.6 &&
          overlap >= fieldWidth * 0.6 &&
          matchingEvidence
        )
      })
      .sort((a, b) => (a.y ?? a.cy) - (b.y ?? b.cy))
    if (resultRows.length > 0) {
      return {
        step: activationStep(resultRows[0]!),
        result: {
          family: 'target',
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
  }
  const exactEvidence = mostSpecificExactTargets(
    context,
    snapshot.elements.filter(
      (element) =>
        element.enabled &&
        element.executable === false &&
        !snapshot.elements.some(
          (candidate) =>
            candidate.enabled &&
            candidate.executable !== false &&
            normalizedLabel(candidate) === normalizedLabel(element)
        )
    )
  )
  if (exactEvidence.length > 0) {
    console.log(
      `[ax-decision] exact non-executable evidence=${exactEvidence
        .map((element) => `[${element.index}] ${element.source ?? 'unknown'}:${element.name || element.value}`)
        .join('; ')}`
    )
    return {
      step: {
        action: 'vision_required',
        why: 'The exact requested target is visible only as structured evidence.'
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
  const failedSearchTargets = snapshot.elements.filter(
    (element) =>
      element.enabled &&
      element.executable !== false &&
      isEditable(element) &&
      Boolean(element.value.trim()) &&
      /search/i.test(`${element.role} ${element.name}`)
  )
  const failedSearchTarget =
    failedSearchTargets.length === 1 ? failedSearchTargets[0] : undefined
  if (
    failedSearchTarget &&
    explicitTextIntent &&
    /\b(?:no matches|no results|0 of|zero results)\b/i.test(snapshot.windowTitle)
  ) {
    return {
      step: { action: 'vision_required', why: 'A bounded free-text writer is required.' },
      writerTargetIndex: failedSearchTarget.index,
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
  const reversibleTargets = snapshot.elements.filter(
    (element) =>
      element.enabled &&
      element.executable !== false &&
      isActionTarget(element) &&
      (element.risk ?? 'reversible') === 'reversible' &&
      !isEditable(element)
  )
  const mostSpecificTargets = mostSpecificExactTargets(context, reversibleTargets)
  const satisfiedExactState = mostSpecificTargets.some(
    (element) =>
      /RadioButton|Option|Tab|CheckBox|Switch|Toggle/i.test(element.role) &&
      (element.selected === true || element.checked === true)
  )
  if (
    satisfiedExactState &&
    !/\b(?:clear|deselect|disable|turn off|uncheck)\b/iu.test(intent)
  ) {
    return {
      step: {
        action: 'milestone_complete',
        summary: 'The requested control state is visible.'
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
  const explicitProgressTarget = explicitStateProgressTarget(context, reversibleTargets)
  if (explicitProgressTarget) {
    return {
      step: activationStep(explicitProgressTarget),
      result: {
        family: 'target',
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
  const orderedTarget = orderedIntentTarget(context, reversibleTargets)
  if (orderedTarget) {
    return {
      step: activationStep(orderedTarget),
      result: {
        family: 'target',
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
  const pathTarget = hierarchicalPathTarget(context, reversibleTargets)
  if (pathTarget) {
    return {
      step: activationStep(pathTarget),
      result: {
        family: 'target',
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
  const exactTarget = uniqueExactTarget(context, reversibleTargets)
  if (
    exactTarget &&
    (targetSpecificity(context, exactTarget) >= 2 || directlyRequestedTarget(context, exactTarget))
  ) {
    return {
      step: activationStep(exactTarget),
      result: {
        family: 'target',
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
  const overallMenuTarget = overallTaskMenuTarget(context, reversibleTargets, snapshot)
  if (overallMenuTarget) {
    return {
      step: activationStep(overallMenuTarget),
      result: {
        family: 'target',
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
  const expandTarget = explicitExpandTarget(context, reversibleTargets)
  if (expandTarget) {
    return {
      step: activationStep(expandTarget),
      result: {
        family: 'target',
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
  const hasEmptyEditable = snapshot.elements.some(
    (element) =>
      element.enabled &&
      element.executable !== false &&
      isEditable(element) &&
      !element.value.trim()
  )
  if (reversibleTargets.length === 1 && !hasEmptyEditable) {
    return {
      step: activationStep(reversibleTargets[0]!),
      result: {
        family: 'target',
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
  const families = actionFamilyCandidates(snapshot, context)
  if (families.length === 0) return noCandidateResult(startedAt, now)
  const familyDecision =
    families.length === 1
      ? { choice: 0, confidence: 1, probabilities: [1] }
      : await score(
          context,
          'Which mutually exclusive action kind is required next?',
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
      'Which target group contains the exact intended control?',
      'Which single listed control is required for the earliest unfinished part of the current milestone? Respect first, then, before, after, and numbered order. Do not skip ahead or repeat an attempted target without fresh evidence that it is still required.'
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
        .filter(
          (element) =>
            element.enabled &&
            element.executable !== false &&
            isEditable(element)
        )
        .map((element) => ({
          description: `Write into field [${element.index}] ${element.role} ${JSON.stringify(element.name || 'unnamed')}${element.focused === true ? ' focused=true' : ''}`,
          step: {
            action: 'vision_required',
            why: 'A bounded free-text writer is required.'
          } as const
        })),
      'Which group contains the field that needs text?',
      'Which field needs text?'
    )
    writerTargetIndex = selected ? Number(/\[(\d+)\]/.exec(selected.description)?.[1]) : undefined
    selectedStep =
      selected?.step ??
      ({ action: 'vision_required', why: 'No editable field was selected.' } as const)
  } else if (selectedFamily === 'press_key') {
    const selected = await chooseCandidate(
      keyboardDecisionCandidates(snapshot, context),
      'Which keyboard-command group contains the required command?',
      'Which single keyboard command is required next?'
    )
    selectedStep =
      selected?.step ??
      ({ action: 'vision_required', why: 'No safe keyboard command was selected.' } as const)
  } else if (selectedFamily === 'propose_completion') {
    const completion = await score(context, 'Does fresh evidence prove the current milestone?', [
      'No. Continue the current milestone.',
      'Yes. The current milestone is visibly complete.'
    ])
    distributions.push(distribution(['continue', 'complete'], completion))
    combinedConfidence *= completion.confidence
    selectedStep =
      completion.choice === 1
        ? { action: 'milestone_complete', summary: 'The current milestone is visibly complete.' }
        : { action: 'vision_required', why: 'The current milestone is not yet complete.' }
  } else if (selectedFamily === 'request_user') {
    selectedStep = { action: 'human_required', why: 'Private or high-risk input is required.' }
  } else if (selectedFamily === 'wait') {
    selectedStep = { action: 'wait', durationMs: 250 }
  } else {
    selectedStep = {
      action: 'vision_required',
      why: 'No safe structured action is available.'
    }
  }
  // A raw product makes the same evidence less executable only because a large
  // choice set needed another safe factorization level. The geometric mean
  // keeps every selected level in the score without exponential depth decay.
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
      : selectedFamily === 'request_user'
        ? 'user_handoff'
        : selectedFamily === 'request_visual_recovery' || selectedFamily === 'no_valid_action'
          ? 'visual_recovery'
          : 'action_kind'
  const selectedRisk =
    'index' in selectedStep
      ? (snapshot.elements.find((element) => element.index === selectedStep.index)?.risk ??
        'reversible')
      : 'reversible'
  const threshold = DECISION_THRESHOLDS[family][selectedRisk]
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
