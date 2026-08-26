import { parseVisionActionFromSourcePixels } from '../vision-action'
import {
  ACTION_VERDICTS,
  type CanonicalActionVerdict,
  type CanonicalDirection,
  DIRECTION_VERDICTS,
  GENERAL_STEP_FIELDS,
  GENERAL_STEP_RESPONSE_FORMAT,
  GENERAL_STEP_SYSTEM_PROMPT
} from './canonical-vision-contract'
import type { VisionModelAdapter, VisionPolicyDecision, VisionPolicyInput } from './types'

export { GENERAL_STEP_RESPONSE_FORMAT } from './canonical-vision-contract'

interface GeneralStepDecision {
  direction: CanonicalDirection
  milestoneComplete: boolean
  actionVerdict: CanonicalActionVerdict
  summary: string
  visibleEvidence: string
  action: string
  actionReason: string
}

function normalizedText(value: unknown, allowEmpty = false): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text && !allowEmpty) return null
  return text
}

const ACTION_PROTOCOL_START =
  /^\s*(?:Action:\s*)?(?:click|left_single|left_double|double_click|right_single|right_click|drag|type|hotkey|scroll|wait|finished|call_user)\s*\(/i

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

export function parseGeneralStepDecision(
  answer: string,
  encodedBounds: { width: number; height: number }
): GeneralStepDecision | null {
  return parseGeneralStepDecisionResult(answer, encodedBounds).decision
}

type GeneralStepDecisionResult =
  | { decision: GeneralStepDecision; error?: undefined }
  | { decision: null; error: string }

function decisionConsistencyError(
  value: Record<string, unknown>,
  action: string,
  encodedBounds: { width: number; height: number }
): string | undefined {
  const actionVerdict = value.action_verdict as GeneralStepDecision['actionVerdict']
  if (value.milestone_complete) {
    if (actionVerdict !== 'none') return 'a completed milestone did not use a none verdict'
    if (value.action !== null) return 'a completed milestone included an action'
    return undefined
  }
  if (actionVerdict !== 'approve') {
    return value.action === null ? undefined : `a ${actionVerdict} verdict included an action`
  }
  if (!action) return 'an approved verdict had no action'
  if (!isSingleActionProtocol(action)) {
    return 'an approved verdict did not contain exactly one action'
  }
  return parseVisionActionFromSourcePixels(action, encodedBounds, encodedBounds)
    ? undefined
    : 'the approved action did not match the action protocol'
}

function generalStepFieldsError(value: Record<string, unknown>): string | undefined {
  const receivedFields = Object.keys(value).sort()
  const expectedFields: string[] = [...GENERAL_STEP_FIELDS].sort()
  if (receivedFields.join(',') === expectedFields.join(',')) return undefined
  const missing = expectedFields.filter((field) => !receivedFields.includes(field))
  const extra = receivedFields.filter((field) => !expectedFields.includes(field))
  return [
    missing.length ? `missing fields: ${missing.join(', ')}` : '',
    extra.length ? `unexpected fields: ${extra.join(', ')}` : ''
  ]
    .filter(Boolean)
    .join('; ')
}

function parseGeneralStepDecisionResult(
  answer: string,
  encodedBounds: { width: number; height: number }
): GeneralStepDecisionResult {
  try {
    const parsed: unknown = JSON.parse(answer)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { decision: null, error: 'the final value was not a JSON object' }
    }
    const value = parsed as Record<string, unknown>
    const fieldsError = generalStepFieldsError(value)
    if (fieldsError) return { decision: null, error: fieldsError }
    if (!DIRECTION_VERDICTS.includes(value.direction as GeneralStepDecision['direction'])) {
      return {
        decision: null,
        error: `direction ${JSON.stringify(value.direction)} was not "aligned" or "off_course"`
      }
    }
    if (!ACTION_VERDICTS.includes(value.action_verdict as GeneralStepDecision['actionVerdict'])) {
      return { decision: null, error: 'action_verdict was not approve, rethink, or none' }
    }
    if (typeof value.milestone_complete !== 'boolean') {
      return { decision: null, error: 'milestone_complete was not a boolean' }
    }
    const summary = normalizedText(value.summary)
    const visibleEvidence = normalizedText(value.visible_evidence)
    const actionVerdict = value.action_verdict as GeneralStepDecision['actionVerdict']
    const action = value.action === null ? '' : normalizedText(value.action, true)
    const actionReason = normalizedText(value.action_reason)
    if (!summary) return { decision: null, error: 'summary was empty or was not text' }
    if (!visibleEvidence)
      return {
        decision: null,
        error: 'visible_evidence was empty or was not text'
      }
    if (action === null)
      return {
        decision: null,
        error: 'action was not text or null'
      }
    if (!actionReason)
      return {
        decision: null,
        error: 'action_reason was empty or was not text'
      }
    const consistencyError = decisionConsistencyError(value, action, encodedBounds)
    if (consistencyError) return { decision: null, error: consistencyError }
    return {
      decision: {
        direction: value.direction as GeneralStepDecision['direction'],
        milestoneComplete: value.milestone_complete,
        actionVerdict,
        summary,
        visibleEvidence,
        action,
        actionReason
      }
    }
  } catch {
    return { decision: null, error: 'the final answer was not valid JSON' }
  }
}

export function generalStepDecisionFailure(
  answer: string,
  encodedBounds: { width: number; height: number }
): string | undefined {
  return parseGeneralStepDecisionResult(answer, encodedBounds).error
}

function taskContext(input: VisionPolicyInput): string {
  const encoded = input.coordinateFrame?.encoded
  return [
    `Task brief:\n${input.goal}`,
    input.currentMilestone ? `Current milestone:\n${input.currentMilestone}` : '',
    input.verifiedActions?.length
      ? `Recent verified actions:\n${input.verifiedActions.slice(-12).join('\n')}`
      : 'Recent verified actions:\nNone yet.',
    input.history.length
      ? `Prior validated judge decisions:\n${input.history
          .slice(-12)
          .map((step) => step.response)
          .join('\n')}`
      : '',
    input.recentSteps.length ? `Recent task events:\n${input.recentSteps.join('\n')}` : '',
    input.olderVisualFacts.length
      ? `Older task outcomes. These can be stale:\n${input.olderVisualFacts.join('\n')}`
      : '',
    encoded
      ? `Screenshot coordinate space:\nThe supplied screenshot is ${encoded.width} pixels wide and ${encoded.height} pixels high. Return action coordinates in this exact pixel space.`
      : '',
    'Inspect the screenshot. Produce the final consolidated direction, milestone, and validated-action decision.'
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
  const verdict = parseGeneralStepDecision(response, encoded)
  if (!verdict) {
    return {
      kind: 'invalid',
      actionText: '',
      error: generalStepDecisionFailure(response, encoded) ?? 'The model decision did not validate.'
    }
  }
  if (verdict.milestoneComplete) {
    return {
      kind: 'phase_complete',
      actionText: 'Milestone complete',
      summary: verdict.summary,
      decisionRationale: verdict.visibleEvidence
    }
  }
  if (verdict.actionVerdict !== 'approve') {
    return {
      kind: 'rethink',
      actionText: verdict.actionVerdict,
      summary: verdict.actionReason,
      direction: verdict.direction,
      decisionRationale: verdict.visibleEvidence
    }
  }
  const actionResponse = `Decision: ${verdict.summary}\nAction: ${verdict.action}`
  const action = parseVisionActionFromSourcePixels(actionResponse, encoded, encoded)
  if (!action) {
    return {
      kind: 'invalid',
      actionText: '',
      error: 'The model action did not parse.',
      decisionRationale: verdict.visibleEvidence
    }
  }
  if (action.type === 'finished') {
    return {
      kind: 'done',
      actionText: action.content,
      summary: action.content || verdict.summary,
      decisionRationale: verdict.visibleEvidence
    }
  }
  if (action.type === 'call_user') {
    return {
      kind: 'handoff',
      actionText: action.content,
      reason: action.content,
      decisionRationale: verdict.visibleEvidence
    }
  }
  if (action.type === 'wait') {
    return {
      kind: 'wait',
      actionText: 'wait',
      durationMs: 0,
      decisionRationale: verdict.visibleEvidence
    }
  }
  return {
    kind: 'actions',
    actionText: verdict.summary,
    actions: [action],
    decisionRationale: `${verdict.visibleEvidence} ${verdict.actionReason}`
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
    maxAttempts: 1,
    responseFormat: GENERAL_STEP_RESPONSE_FORMAT,
    temperature: 0.1,
    topP: 0.9,
    enableThinking: true,
    separateReasoning: true,
    requireFinalAnswer: true,
    validateResponse: (answer) =>
      encoded ? parseGeneralStepDecision(answer, encoded) !== null : false,
    responseValidationError: (answer) =>
      encoded ? generalStepDecisionFailure(answer, encoded) : 'screenshot bounds were missing'
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
