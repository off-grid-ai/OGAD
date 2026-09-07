import { computerUseAdapterProfile } from '@offgrid/models/computer-use'
import type { Bounds, VisionAction } from '../vision-action'
import type {
  VisionModelAdapter,
  VisionPolicyDecision,
  VisionPolicyInput,
  VisionPolicyResponse,
  VisionPolicyToolCall
} from './types'

const FARA_SYSTEM_PROMPT = `You are Fara, a computer use agent (CUA) specialized for web browsers. You are developed by Microsoft AI Frontiers. You assist users with completing and automating tasks that require the use of a web browser.

The model was trained in the timeframe of January - April 2026. You can effectively perform tasks even beyond this range by accessing the web browser and using the latest information on the live web. But your knowledge cutoff is limited to early 2026, so you may not be aware of events or developments that occurred after that time, without explicitly browsing and searching for latest information on the web.

A critical point is a situation where we must pause and request information or confirmation from the user before proceeding. There are three types:

Case 1: Missing User Information — The task requires personal information that the user has not provided (e.g., email, phone number, address, payment details). Never fabricate or assume personal information. Fill in only what the user has explicitly provided, then pause and ask for any missing required fields. If the user has provided all required information, proceed without stopping.

Case 2: Underspecified Task — The task description is ambiguous or missing details needed to make a decision at the current step. Pause and ask for clarification. If the user's instructions contain all information needed for the current decision, proceed without stopping.

Case 3: Irreversible Action — We are about to perform an action that cannot be undone (e.g., submitting a form, completing a purchase, sending a message, deleting data). If the user explicitly authorized the action, proceed without stopping. If the user did not explicitly authorize the action, stop and ask for confirmation.

Only stop at a critical point if required information is missing, the task is ambiguous, or an irreversible action lacks explicit user authorization. If the user has provided all necessary information and explicitly authorized the action, proceed without interruption.`

const FARA_ACTIONS = [
  'key',
  'type',
  'mouse_move',
  'left_click',
  'left_click_drag',
  'right_click',
  'double_click',
  'triple_click',
  'scroll',
  'hscroll',
  'visit_url',
  'history_back',
  'web_search',
  'ask_user_question',
  'wait',
  'terminate'
] as const

function faraComputerUseTool(bounds: Bounds): unknown {
  return {
    type: 'function',
    function: {
      name: 'computer_use',
      description: `Use the mouse and keyboard in the current browser page. The screenshot resolution is ${bounds.width}x${bounds.height}. Return pixel coordinates in this exact frame.`,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: FARA_ACTIONS },
          keys: { type: 'array', items: { type: 'string' } },
          text: { type: 'string' },
          coordinate: {
            type: 'array',
            description: `(x, y) pixel coordinate in the ${bounds.width}x${bounds.height} screenshot.`,
            items: { type: 'number' },
            minItems: 2,
            maxItems: 2
          },
          pixels: { type: 'number' },
          url: { type: 'string' },
          query: { type: 'string' },
          question: { type: 'string' },
          time: { type: 'number', minimum: 0, maximum: 30 },
          answer: { type: 'string' }
        },
        required: ['action']
      }
    }
  } as const
}

type FaraArgs = Record<string, unknown> & { action: string }

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function faraCallFromContent(content: string): VisionPolicyToolCall | null {
  const calls = [...content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi)]
  if (calls.length !== 1) return null
  try {
    const value = objectValue(JSON.parse(calls[0]?.[1] ?? ''))
    const args = objectValue(value?.arguments)
    if (value?.name !== 'computer_use' || !args) return null
    return { id: 'fara-1.5-call', name: 'computer_use', arguments: JSON.stringify(args) }
  } catch {
    return null
  }
}

function faraCall(response: VisionPolicyResponse): VisionPolicyToolCall | null {
  if (response.toolCalls.length === 1) return response.toolCalls[0] ?? null
  if (response.toolCalls.length > 1) return null
  return faraCallFromContent(response.content)
}

function parsedArgs(response: VisionPolicyResponse): FaraArgs | null {
  const call = faraCall(response)
  if (!call || call.name !== 'computer_use') return null
  try {
    const args = objectValue(JSON.parse(call.arguments))
    return args && typeof args.action === 'string' ? (args as FaraArgs) : null
  } catch {
    return null
  }
}

function point(value: unknown, bounds: Bounds): { x: number; y: number } | null {
  if (!Array.isArray(value) || value.length !== 2) return null
  const x = Number(value[0])
  const y = Number(value[1])
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    x > bounds.width ||
    y < 0 ||
    y > bounds.height
  ) {
    return null
  }
  return { x, y }
}

function webUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

type FaraActionDecoder = (args: FaraArgs, bounds: Bounds) => VisionAction | null

function pointAction(
  build: (target: NonNullable<ReturnType<typeof point>>) => VisionAction
): FaraActionDecoder {
  return (args, bounds) => {
    const target = point(args.coordinate, bounds)
    return target ? build(target) : null
  }
}

function scrollAction(axis: 'vertical' | 'horizontal'): FaraActionDecoder {
  return (args) => {
    const amount = Number(args.pixels)
    return Number.isFinite(amount) ? { type: 'scroll_by', axis, amount } : null
  }
}

const FARA_ACTION_DECODERS: Readonly<Record<string, FaraActionDecoder>> = {
  left_click: pointAction((target) => ({ type: 'click', point: target })),
  double_click: pointAction((target) => ({ type: 'double_click', point: target })),
  right_click: pointAction((target) => ({ type: 'right_click', point: target })),
  triple_click: pointAction((target) => ({ type: 'triple_click', point: target })),
  mouse_move: pointAction((target) => ({ type: 'mouse_move', point: target })),
  left_click_drag: pointAction((target) => ({ type: 'drag_to', to: target })),
  type: (args) => {
    const content = typeof args.text === 'string' ? args.text : null
    return content === null ? null : { type: 'type', content }
  },
  key: (args) =>
    Array.isArray(args.keys) && args.keys.every((key) => typeof key === 'string')
      ? { type: 'press', keys: args.keys as string[] }
      : null,
  scroll: scrollAction('vertical'),
  hscroll: scrollAction('horizontal'),
  visit_url: (args) => {
    const url = webUrl(args.url)
    return url ? { type: 'navigate', url } : null
  },
  history_back: () => ({ type: 'press', keys: ['ALT', 'LEFT'] }),
  web_search: (args) => {
    const query = text(args.query)
    return query
      ? { type: 'navigate', url: `https://www.google.com/search?q=${encodeURIComponent(query)}` }
      : null
  }
}

function actionFrom(args: FaraArgs, bounds: Bounds): VisionAction | null {
  return FARA_ACTION_DECODERS[args.action]?.(args, bounds) ?? null
}

export function parseFaraPolicyResponse(
  response: VisionPolicyResponse,
  bounds: Bounds
): VisionPolicyDecision {
  const args = parsedArgs(response)
  if (!args || !FARA_ACTIONS.includes(args.action as (typeof FARA_ACTIONS)[number])) {
    return { kind: 'invalid', actionText: '', error: 'Fara 1.5 tool call did not parse.' }
  }
  if (args.action === 'terminate') {
    const summary = text(args.answer)
    return summary
      ? { kind: 'done', actionText: summary, summary }
      : { kind: 'invalid', actionText: '', error: 'Fara 1.5 terminate needs an answer.' }
  }
  if (args.action === 'ask_user_question') {
    const reason = text(args.question)
    return reason
      ? { kind: 'handoff', actionText: reason, reason }
      : { kind: 'invalid', actionText: '', error: 'Fara 1.5 handoff needs a question.' }
  }
  if (args.action === 'wait') {
    const seconds = Number(args.time)
    return Number.isFinite(seconds) && seconds >= 0 && seconds <= 30
      ? { kind: 'wait', actionText: 'wait', durationMs: seconds * 1000 }
      : { kind: 'invalid', actionText: '', error: 'Fara 1.5 wait needs 0-30 seconds.' }
  }
  const action = actionFrom(args, bounds)
  return action
    ? { kind: 'actions', actionText: args.action, actions: [action] }
    : { kind: 'invalid', actionText: '', error: `Fara 1.5 ${args.action} arguments did not parse.` }
}

function taskContext(input: VisionPolicyInput): string {
  return [
    input.goal,
    input.currentMilestone ? `Current milestone: ${input.currentMilestone}` : '',
    input.history.length
      ? `Prior thoughts and actions:\n${input.history
          .slice(-12)
          .map((step) => step.response)
          .join('\n')}`
      : '',
    'Here is the next screenshot. Think about what to do next.'
  ]
    .filter(Boolean)
    .join('\n\n')
}

function buildFaraRequest(
  input: VisionPolicyInput
): ReturnType<VisionModelAdapter['buildRequest']> {
  if (input.operatorEnvironment !== 'embedded_browser') {
    throw new Error('Fara 1.5 supports Web Use only. Choose another model for Computer Use.')
  }
  const bounds = input.coordinateFrame?.encoded
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    throw new Error('Fara 1.5 needs valid screenshot bounds.')
  }
  return {
    messages: [
      { role: 'system', content: FARA_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: taskContext(input) },
          { type: 'image_url', image_url: { url: input.currentScreenshotDataUrl } }
        ]
      }
    ],
    ...computerUseAdapterProfile('fara'),
    tools: [faraComputerUseTool(bounds)],
    toolChoice: 'required',
    separateReasoning: true,
    validateResponse: (response) => parseFaraPolicyResponse(response, bounds).kind !== 'invalid',
    responseValidationError: (response) => {
      const decision = parseFaraPolicyResponse(response, bounds)
      return decision.kind === 'invalid' ? decision.error : undefined
    }
  }
}

export const fara15Adapter: VisionModelAdapter = {
  id: 'fara-1.5',
  screenshotResizeFactor: 32,
  browserCaptureScope: 'page',
  requiresLoadCapabilityGate: true,
  matches(model) {
    return /fara[-_ ]?1\.5/i.test(`${model.id} ${model.primaryFile}`)
  },
  assertCapabilities(model) {
    if (!model.projectorFile || !model.availableFiles.includes(model.projectorFile)) {
      throw new Error('The selected Fara 1.5 model has no installed vision projector.')
    }
  },
  buildRequest: buildFaraRequest,
  parseResponse(content, bounds) {
    return parseFaraPolicyResponse({ content, toolCalls: [] }, bounds)
  },
  parsePolicyResponse: parseFaraPolicyResponse
}
