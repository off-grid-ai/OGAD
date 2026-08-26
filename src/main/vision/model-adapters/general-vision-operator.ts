import { parseVisionAction } from '../vision-action'
import {
  type CanonicalDirection,
  DIRECTION_VERDICTS,
  GENERAL_STEP_RESPONSE_FORMAT,
  GENERAL_STEP_SYSTEM_PROMPT,
  VISION_STEP_COMMANDS
} from './canonical-vision-contract'
import type { VisionModelAdapter, VisionPolicyDecision, VisionPolicyInput } from './types'

export { GENERAL_STEP_RESPONSE_FORMAT } from './canonical-vision-contract'

type GeneralStepCommand =
  | {
      name: 'complete_milestone'
      summary: string
      visibleEvidence: string
    }
  | {
      name: 'perform_action'
      direction: CanonicalDirection
      summary: string
      visibleEvidence: string
      action: string
      actionReason: string
    }
  | {
      name: 'rethink'
      direction: CanonicalDirection
      summary: string
      visibleEvidence: string
    }

function normalizedText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/g, ' ').trim()
  return text || null
}

const ACTION_PROTOCOL_START =
  /^\s*(?:Action:\s*)?(?:click|left_single|left_double|double_click|right_single|right_click|drag|type|hotkey|scroll|navigate|wait|finished|call_user)\s*\(/i

function isSingleActionProtocol(value: string): boolean {
  if (/<\/?(?:tool_call|action)\b/i.test(value)) return false
  const start = value.match(ACTION_PROTOCOL_START)
  if (!start) return false
  let depth = 1
  let quote = ''
  let escaped = false
  for (let index = start[0].length; index < value.length; index += 1) {
    const character = value[index] ?? ''
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\' && quote) {
      escaped = true
      continue
    }
    if (["'", '"'].includes(character)) {
      quote = quote === character ? '' : quote || character
      continue
    }
    if (quote) continue
    if (character === '(') depth += 1
    if (character !== ')') continue
    depth -= 1
    if (depth === 0) return value.slice(index + 1).trim().length === 0
  }
  return false
}

type GeneralStepCommandResult =
  | { command: GeneralStepCommand; error?: undefined }
  | { command: null; error: string }

function fieldsError(
  value: Record<string, unknown>,
  expectedFields: readonly string[]
): string | null {
  const receivedFields = Object.keys(value)
  const missing = expectedFields.filter((field) => !receivedFields.includes(field))
  const extra = receivedFields.filter((field) => !expectedFields.includes(field))
  if (missing.length === 0 && extra.length === 0) return null
  return [
    missing.length ? `missing fields: ${missing.join(', ')}` : '',
    extra.length ? `unexpected fields: ${extra.join(', ')}` : ''
  ]
    .filter(Boolean)
    .join('; ')
}

function parseCompleteMilestone(value: Record<string, unknown>): GeneralStepCommandResult {
  const fieldError = fieldsError(value, ['name', 'summary', 'visible_evidence'])
  if (fieldError) return { command: null, error: fieldError }
  const summary = normalizedText(value.summary)
  const visibleEvidence = normalizedText(value.visible_evidence)
  if (!summary) return { command: null, error: 'summary was empty or was not text' }
  if (!visibleEvidence) {
    return { command: null, error: 'visible_evidence was empty or was not text' }
  }
  return { command: { name: 'complete_milestone', summary, visibleEvidence } }
}

function parsePerformAction(
  value: Record<string, unknown>,
  encodedBounds: { width: number; height: number }
): GeneralStepCommandResult {
  const fieldError = fieldsError(value, [
    'name',
    'direction',
    'summary',
    'visible_evidence',
    'action',
    'action_reason'
  ])
  if (fieldError) return { command: null, error: fieldError }
  if (!DIRECTION_VERDICTS.includes(value.direction as CanonicalDirection)) {
    return {
      command: null,
      error: `direction ${JSON.stringify(value.direction)} was not "aligned" or "off_course"`
    }
  }
  const summary = normalizedText(value.summary)
  const visibleEvidence = normalizedText(value.visible_evidence)
  const action = normalizedText(value.action)
  const actionReason = normalizedText(value.action_reason)
  if (!summary) return { command: null, error: 'summary was empty or was not text' }
  if (!visibleEvidence) {
    return { command: null, error: 'visible_evidence was empty or was not text' }
  }
  if (!action) return { command: null, error: 'action was empty or was not text' }
  if (!actionReason) return { command: null, error: 'action_reason was empty or was not text' }
  if (!isSingleActionProtocol(action)) {
    return { command: null, error: 'perform_action did not contain exactly one action' }
  }
  if (!parseVisionAction(action, encodedBounds)) {
    return { command: null, error: 'the action did not match the action protocol' }
  }
  return {
    command: {
      name: 'perform_action',
      direction: value.direction as CanonicalDirection,
      summary,
      visibleEvidence,
      action,
      actionReason
    }
  }
}

function parseRethink(value: Record<string, unknown>): GeneralStepCommandResult {
  const fieldError = fieldsError(value, ['name', 'direction', 'summary', 'visible_evidence'])
  if (fieldError) return { command: null, error: fieldError }
  if (!DIRECTION_VERDICTS.includes(value.direction as CanonicalDirection)) {
    return {
      command: null,
      error: `direction ${JSON.stringify(value.direction)} was not "aligned" or "off_course"`
    }
  }
  const summary = normalizedText(value.summary)
  const visibleEvidence = normalizedText(value.visible_evidence)
  if (!summary) return { command: null, error: 'summary was empty or was not text' }
  if (!visibleEvidence) {
    return { command: null, error: 'visible_evidence was empty or was not text' }
  }
  return {
    command: {
      name: 'rethink',
      direction: value.direction as CanonicalDirection,
      summary,
      visibleEvidence
    }
  }
}

/** Accept only the safe part of the retired flat contract. Old or weaker local
 * models can still report a completed milestone, but any mixed-in action is
 * discarded before LangGraph sees the transition. */
function parseLegacyCompletion(value: Record<string, unknown>): GeneralStepCommandResult | null {
  if (value.milestone_complete !== true) return null
  const summary = normalizedText(value.summary)
  const visibleEvidence = normalizedText(value.visible_evidence)
  if (!summary) return { command: null, error: 'summary was empty or was not text' }
  if (!visibleEvidence) {
    return { command: null, error: 'visible_evidence was empty or was not text' }
  }
  return { command: { name: 'complete_milestone', summary, visibleEvidence } }
}

function parseGeneralStepCommandResult(
  answer: string,
  encodedBounds: { width: number; height: number }
): GeneralStepCommandResult {
  try {
    const parsed: unknown = JSON.parse(answer)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { command: null, error: 'the final value was not a JSON object' }
    }
    const value = parsed as Record<string, unknown>
    const legacy = parseLegacyCompletion(value)
    if (legacy) return legacy
    const outerFieldsError = fieldsError(value, ['command'])
    if (outerFieldsError) return { command: null, error: outerFieldsError }
    if (!value.command || typeof value.command !== 'object' || Array.isArray(value.command)) {
      return { command: null, error: 'command was not an object' }
    }
    const command = value.command as Record<string, unknown>
    if (!VISION_STEP_COMMANDS.includes(command.name as GeneralStepCommand['name'])) {
      return {
        command: null,
        error: 'command name was not complete_milestone, perform_action, or rethink'
      }
    }
    if (command.name === 'complete_milestone') return parseCompleteMilestone(command)
    if (command.name === 'perform_action') return parsePerformAction(command, encodedBounds)
    return parseRethink(command)
  } catch {
    return { command: null, error: 'the final answer was not valid JSON' }
  }
}

export function parseGeneralStepCommand(
  answer: string,
  encodedBounds: { width: number; height: number }
): GeneralStepCommand | null {
  return parseGeneralStepCommandResult(answer, encodedBounds).command
}

export function generalStepCommandFailure(
  answer: string,
  encodedBounds: { width: number; height: number }
): string | undefined {
  return parseGeneralStepCommandResult(answer, encodedBounds).error
}

function taskContext(input: VisionPolicyInput): string {
  const encoded = input.coordinateFrame?.encoded
  return [
    `Task brief:\n${input.goal}`,
    input.operatorEnvironment === 'embedded_browser'
      ? [
          'Web Use control limits:',
          '- The screenshot contains the web page only. It has no native address bar or tab strip.',
          "- Use hotkey(key='ALT+LEFT') for Browser Back and hotkey(key='ALT+RIGHT') for Browser Forward.",
          "- Use hotkey(key='CTRL+R') only to reload the current page. The host maps the primary modifier for its platform.",
          "- Use navigate(url='https://...') to open a different website. Do not try to focus an address bar first.",
          '- Never use CTRL+L, CMD+L, CTRL+W, or CMD+W. Those browser-chrome controls do not exist in this action surface.',
          '- To leave an accidental detail or booking page, use Browser Back.'
        ].join('\n')
      : '',
    input.currentMilestone ? `Current milestone:\n${input.currentMilestone}` : '',
    input.verifiedActions?.length
      ? `Recent verified actions:\n${input.verifiedActions.slice(-12).join('\n')}`
      : 'Recent verified actions:\nNone yet.',
    input.previousClickMarker
      ? `Previous action to judge:\n${input.verifiedActions?.at(-1) ?? 'click'}\nThe emerald-green marker at (${input.previousClickMarker.x}, ${input.previousClickMarker.y}) shows where that click landed in the current screenshot. Verify its visible result before choosing the next command.`
      : '',
    input.history.length
      ? `Prior validated commands:\n${input.history
          .slice(-12)
          .map((step) => step.response)
          .join('\n')}`
      : '',
    input.recentSteps.length ? `Recent task events:\n${input.recentSteps.join('\n')}` : '',
    input.olderVisualFacts.length
      ? `Older task outcomes. These can be stale:\n${input.olderVisualFacts.join('\n')}`
      : '',
    encoded
      ? `Screenshot coordinate space:\nThe supplied screenshot is ${encoded.width} pixels wide and ${encoded.height} pixels high. Return every action point in the model's 0-1000 normalized coordinate space: x=0 is the left edge, x=1000 is the right edge, y=0 is the top edge, and y=1000 is the bottom edge.`
      : '',
    'Inspect the screenshot and choose exactly one transition command.'
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function parseGeneralVisionOperatorResponse(
  response: string,
  bounds: Parameters<VisionModelAdapter['parseResponse']>[1],
  coordinateFrame?: Parameters<VisionModelAdapter['parseResponse']>[2]
): VisionPolicyDecision {
  const encoded = coordinateFrame?.encoded ?? bounds
  const command = parseGeneralStepCommand(response, encoded)
  if (!command) {
    return {
      kind: 'invalid',
      actionText: '',
      error: generalStepCommandFailure(response, encoded) ?? 'The model command did not validate.'
    }
  }
  if (command.name === 'complete_milestone') {
    return {
      kind: 'phase_complete',
      actionText: 'Milestone complete',
      summary: command.summary,
      decisionRationale: command.visibleEvidence
    }
  }
  if (command.name === 'rethink') {
    return {
      kind: 'rethink',
      actionText: 'rethink',
      summary: command.summary,
      direction: command.direction,
      decisionRationale: command.visibleEvidence
    }
  }
  const actionResponse = `Decision: ${command.summary}\nAction: ${command.action}`
  const action = parseVisionAction(actionResponse, encoded)
  if (!action) {
    return {
      kind: 'invalid',
      actionText: '',
      error: 'The model action did not parse.',
      decisionRationale: command.visibleEvidence
    }
  }
  if (action.type === 'finished') {
    return {
      kind: 'done',
      actionText: action.content,
      summary: action.content || command.summary,
      decisionRationale: command.visibleEvidence
    }
  }
  if (action.type === 'call_user') {
    return {
      kind: 'handoff',
      actionText: action.content,
      reason: action.content,
      decisionRationale: command.visibleEvidence
    }
  }
  if (action.type === 'wait') {
    return {
      kind: 'wait',
      actionText: 'wait',
      durationMs: 0,
      decisionRationale: command.visibleEvidence
    }
  }
  return {
    kind: 'actions',
    actionText: command.summary,
    actions: [action],
    decisionRationale: `${command.visibleEvidence} ${command.actionReason}`
  }
}

export function buildCanonicalVisionOperatorRequest(
  input: VisionPolicyInput
): ReturnType<VisionModelAdapter['buildRequest']> {
  const encoded = input.coordinateFrame?.encoded
  return {
    messages: [
      { role: 'system', content: GENERAL_STEP_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: taskContext(input) },
          { type: 'image_url', image_url: { url: input.currentScreenshotDataUrl } }
        ]
      }
    ],
    maxTokens: 1_200,
    timeoutMs: 90_000,
    maxAttempts: 2,
    responseFormat: GENERAL_STEP_RESPONSE_FORMAT,
    temperature: 0.1,
    topP: 0.9,
    enableThinking: true,
    separateReasoning: true,
    requireFinalAnswer: true,
    validateResponse: (answer) =>
      encoded ? parseGeneralStepCommand(answer, encoded) !== null : false,
    responseValidationError: (answer) =>
      encoded ? generalStepCommandFailure(answer, encoded) : 'screenshot bounds were missing'
  }
}

export const generalVisionOperatorAdapter: VisionModelAdapter = {
  id: 'general-vision-operator',
  matches(model) {
    return /(?:gemma[-_]?4|qwen3(?:[._-]?(?:5|8|vl))?)/i.test(`${model.id} ${model.primaryFile}`)
  },
  assertCapabilities(model) {
    if (!model.projectorFile || !model.availableFiles.includes(model.projectorFile)) {
      throw new Error('The active general vision model has no installed vision projector.')
    }
  },
  buildRequest: buildCanonicalVisionOperatorRequest,
  parseResponse: parseGeneralVisionOperatorResponse
}
