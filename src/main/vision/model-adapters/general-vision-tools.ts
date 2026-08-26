import type { Bounds, Point, VisionAction } from '../vision-action'
import type { VisionPolicyDecision, VisionPolicyResponse, VisionPolicyToolCall } from './types'

export const GENERAL_VISION_TOOL_NAMES = [
  'complete_milestone',
  'perform_action',
  'rethink',
  'call_user'
] as const
export const DIRECTION_VERDICTS = ['aligned', 'off_course'] as const

type ToolName = (typeof GENERAL_VISION_TOOL_NAMES)[number]
type Direction = (typeof DIRECTION_VERDICTS)[number]
type ObjectValue = Record<string, unknown>
type DecisionResult =
  | { decision: VisionPolicyDecision; error?: undefined }
  | { decision?: undefined; error: string }

function fieldsError(value: ObjectValue, expectedFields: readonly string[]): string | null {
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

function objectValue(value: unknown): ObjectValue | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : null
}

function normalizedText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/g, ' ').trim()
  return text || null
}

function direction(value: unknown): Direction | null {
  return DIRECTION_VERDICTS.includes(value as Direction) ? (value as Direction) : null
}

function normalizedPoint(value: unknown, bounds: Bounds): Point | null {
  const pointValue = objectValue(value)
  if (!pointValue || fieldsError(pointValue, ['x', 'y'])) return null
  const x = Number(pointValue.x)
  const y = Number(pointValue.y)
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    x > 1000 ||
    y < 0 ||
    y > 1000 ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    return null
  }
  return {
    x: Math.min(bounds.width - 1, Math.max(0, Math.round((x / 1000) * bounds.width))),
    y: Math.min(bounds.height - 1, Math.max(0, Math.round((y / 1000) * bounds.height)))
  }
}

type ActionDecoder = (value: ObjectValue, bounds: Bounds) => VisionAction | null

function pointAction(type: 'click' | 'double_click' | 'right_click'): ActionDecoder {
  return (value, bounds) => {
    if (fieldsError(value, ['type', 'point'])) return null
    const point = normalizedPoint(value.point, bounds)
    return point ? { type, point } : null
  }
}

const ACTION_DECODERS: Record<string, ActionDecoder> = {
  click: pointAction('click'),
  double_click: pointAction('double_click'),
  right_click: pointAction('right_click'),
  drag(value, bounds) {
    if (fieldsError(value, ['type', 'from', 'to'])) return null
    const from = normalizedPoint(value.from, bounds)
    const to = normalizedPoint(value.to, bounds)
    return from && to ? { type: 'drag', from, to } : null
  },
  type(value) {
    if (fieldsError(value, ['type', 'content'])) return null
    return typeof value.content === 'string' ? { type: 'type', content: value.content } : null
  },
  hotkey(value) {
    if (fieldsError(value, ['type', 'keys'])) return null
    const keys = normalizedText(value.keys)
    return keys ? { type: 'hotkey', keys } : null
  },
  scroll(value, bounds) {
    if (fieldsError(value, ['type', 'point', 'direction'])) return null
    const point = normalizedPoint(value.point, bounds)
    const scrollDirection = String(value.direction)
    if (!point || !['up', 'down', 'left', 'right'].includes(scrollDirection)) return null
    return {
      type: 'scroll',
      point,
      direction: scrollDirection as 'up' | 'down' | 'left' | 'right'
    }
  },
  navigate(value) {
    if (fieldsError(value, ['type', 'url'])) return null
    const rawUrl = normalizedText(value.url)
    if (!rawUrl) return null
    try {
      const url = new URL(rawUrl)
      return url.protocol === 'http:' || url.protocol === 'https:'
        ? { type: 'navigate', url: url.toString() }
        : null
    } catch {
      return null
    }
  },
  wait(value) {
    if (fieldsError(value, ['type', 'duration_ms'])) return null
    const durationMs = Number(value.duration_ms)
    return Number.isFinite(durationMs) && durationMs >= 0 && durationMs <= 30_000
      ? { type: 'wait', durationMs }
      : null
  }
}

function structuredAction(value: unknown, bounds: Bounds): VisionAction | null {
  const action = objectValue(value)
  const decoder =
    action && typeof action.type === 'string' ? ACTION_DECODERS[action.type] : undefined
  return action && decoder ? decoder(action, bounds) : null
}

function commonText(
  value: ObjectValue,
  expectedFields: readonly string[]
): { summary: string; visibleEvidence: string } | { error: string } {
  const invalidFields = fieldsError(value, expectedFields)
  if (invalidFields) return { error: invalidFields }
  const summary = normalizedText(value.summary)
  const visibleEvidence = normalizedText(value.visible_evidence)
  if (!summary) return { error: 'summary was empty or was not text' }
  if (!visibleEvidence) return { error: 'visible_evidence was empty or was not text' }
  return { summary, visibleEvidence }
}

function completeMilestone(value: ObjectValue): DecisionResult {
  const common = commonText(value, ['summary', 'visible_evidence'])
  return 'error' in common
    ? common
    : {
        decision: {
          kind: 'phase_complete',
          actionText: 'Milestone complete',
          summary: common.summary,
          decisionRationale: common.visibleEvidence
        }
      }
}

function rethink(value: ObjectValue): DecisionResult {
  const common = commonText(value, ['direction', 'summary', 'visible_evidence'])
  if ('error' in common) return common
  const parsedDirection = direction(value.direction)
  if (!parsedDirection) {
    return {
      error: `direction ${JSON.stringify(value.direction)} was not "aligned" or "off_course"`
    }
  }
  return {
    decision: {
      kind: 'rethink',
      actionText: 'rethink',
      summary: common.summary,
      direction: parsedDirection,
      decisionRationale: common.visibleEvidence
    }
  }
}

function callUser(value: ObjectValue): DecisionResult {
  const invalidFields = fieldsError(value, ['reason', 'visible_evidence'])
  if (invalidFields) return { error: invalidFields }
  const reason = normalizedText(value.reason)
  const visibleEvidence = normalizedText(value.visible_evidence)
  if (!reason) return { error: 'reason was empty or was not text' }
  if (!visibleEvidence) return { error: 'visible_evidence was empty or was not text' }
  return {
    decision: {
      kind: 'handoff',
      actionText: reason,
      reason,
      decisionRationale: visibleEvidence
    }
  }
}

function performAction(value: ObjectValue, bounds: Bounds): DecisionResult {
  const common = commonText(value, [
    'direction',
    'summary',
    'visible_evidence',
    'action',
    'action_reason'
  ])
  if ('error' in common) return common
  if (!direction(value.direction)) {
    return {
      error: `direction ${JSON.stringify(value.direction)} was not "aligned" or "off_course"`
    }
  }
  const action = structuredAction(value.action, bounds)
  const actionReason = normalizedText(value.action_reason)
  if (!action) return { error: 'action was not one supported structured action' }
  if (!actionReason) return { error: 'action_reason was empty or was not text' }
  if (action.type === 'wait') {
    return {
      decision: {
        kind: 'wait',
        actionText: 'wait',
        durationMs: action.durationMs ?? 0,
        decisionRationale: common.visibleEvidence
      }
    }
  }
  return {
    decision: {
      kind: 'actions',
      actionText: common.summary,
      actions: [action],
      decisionRationale: `${common.visibleEvidence} ${actionReason}`
    }
  }
}

const TOOL_DECODERS: Partial<
  Record<ToolName, (value: ObjectValue, bounds: Bounds) => DecisionResult>
> = {
  complete_milestone: completeMilestone,
  perform_action: performAction,
  rethink,
  call_user: callUser
}

function toolArguments(call: VisionPolicyToolCall): ObjectValue | null {
  try {
    return objectValue(JSON.parse(call.arguments))
  } catch {
    return null
  }
}

function decodeToolResponse(response: VisionPolicyResponse, bounds: Bounds): DecisionResult {
  if (response.toolCalls.length !== 1) {
    return {
      error: `the model returned ${response.toolCalls.length} tool calls; exactly one is required`
    }
  }
  const call = response.toolCalls[0]!
  const decoder = TOOL_DECODERS[call.name as ToolName]
  if (!decoder) return { error: `unsupported vision tool ${JSON.stringify(call.name)}` }
  const value = toolArguments(call)
  return value ? decoder(value, bounds) : { error: `${call.name} arguments were not a JSON object` }
}

export function generalVisionPolicyFailure(
  response: VisionPolicyResponse,
  bounds: Bounds
): string | undefined {
  return decodeToolResponse(response, bounds).error
}

export function parseGeneralVisionToolResponse(
  response: VisionPolicyResponse,
  bounds: Bounds
): VisionPolicyDecision {
  const result = decodeToolResponse(response, bounds)
  return result.decision ?? { kind: 'invalid', actionText: '', error: result.error }
}

const text = { type: 'string' } as const
const number = { type: 'number', minimum: 0, maximum: 1000 } as const
const directionSchema = { type: 'string', enum: DIRECTION_VERDICTS } as const
const point = {
  type: 'object',
  properties: { x: number, y: number },
  required: ['x', 'y'],
  additionalProperties: false
} as const
const structuredActionSchema = {
  anyOf: [
    ...(['click', 'double_click', 'right_click'] as const).map((type) => ({
      type: 'object',
      properties: { type: { type: 'string', enum: [type] }, point },
      required: ['type', 'point'],
      additionalProperties: false
    })),
    {
      type: 'object',
      properties: { type: { type: 'string', enum: ['drag'] }, from: point, to: point },
      required: ['type', 'from', 'to'],
      additionalProperties: false
    },
    ...(['type', 'hotkey'] as const).map((type) => ({
      type: 'object',
      properties: {
        type: { type: 'string', enum: [type] },
        [type === 'type' ? 'content' : 'keys']: text
      },
      required: ['type', type === 'type' ? 'content' : 'keys'],
      additionalProperties: false
    })),
    {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['scroll'] },
        point,
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }
      },
      required: ['type', 'point', 'direction'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: { type: { type: 'string', enum: ['navigate'] }, url: text },
      required: ['type', 'url'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['wait'] },
        duration_ms: { type: 'number', minimum: 0, maximum: 30000 }
      },
      required: ['type', 'duration_ms'],
      additionalProperties: false
    }
  ]
} as const

interface NativeToolInput {
  name: ToolName
  description: string
  properties: Record<string, unknown>
  required: readonly string[]
}

function nativeTool(input: NativeToolInput): unknown {
  return {
    type: 'function',
    function: {
      name: input.name,
      description: input.description,
      strict: true,
      parameters: {
        type: 'object',
        properties: input.properties,
        required: input.required,
        additionalProperties: false
      }
    }
  }
}

export const GENERAL_VISION_TOOLS = [
  nativeTool({
    name: 'complete_milestone',
    description: 'Report that the current milestone result is visibly complete.',
    properties: { summary: text, visible_evidence: text },
    required: ['summary', 'visible_evidence']
  }),
  nativeTool({
    name: 'perform_action',
    description: 'Perform exactly one verified action that advances the current milestone.',
    properties: {
      direction: directionSchema,
      summary: text,
      visible_evidence: text,
      action: structuredActionSchema,
      action_reason: text
    },
    required: ['direction', 'summary', 'visible_evidence', 'action', 'action_reason']
  }),
  nativeTool({
    name: 'rethink',
    description: 'Request a fresh observation because no safe decision is visible.',
    properties: { direction: directionSchema, summary: text, visible_evidence: text },
    required: ['direction', 'summary', 'visible_evidence']
  }),
  nativeTool({
    name: 'call_user',
    description: 'Pause for the user to complete a private or credential step.',
    properties: { reason: text, visible_evidence: text },
    required: ['reason', 'visible_evidence']
  })
] as const
