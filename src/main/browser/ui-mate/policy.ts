/**
 * Private TypeScript policy adapter for Tencent UI-Mate.
 *
 * Protocol source of truth (Apache-2.0), pinned to the reviewed revision:
 * https://github.com/Tencent/UI-Mate/blob/d2b2e0aede83eeacfb1bc86f66503acbc4a6738a/agents/ui_mate_agent.py
 *
 * This module translates the model protocol only. It does not own a browser,
 * execute input, or decide whether an action is allowed.
 */

export const UI_MATE_ACTIONS = [
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'drag',
  'mouse_move',
  'type',
  'hotkey',
  'press',
  'key_down',
  'key_up',
  'scroll',
  'wait',
  'call_user',
  'finished'
] as const

export type UIMateActionName = (typeof UI_MATE_ACTIONS)[number]
export type UIMateControl = 'WAIT' | 'DONE' | 'FAIL'

export const UI_MATE_GENERATION_CONFIG = {
  maxTokens: 16_384,
  temperature: 1,
  topP: 0.95
} as const

export const UI_MATE_MAX_HISTORY_STEPS = 100

export interface UIMateAction {
  action: UIMateActionName
  coordinate?: readonly [number, number]
  text?: string
  keys?: readonly string[]
  pixels?: number
  direction?: 'vertical' | 'horizontal'
  time?: number
  status?: 'success' | 'failure'
}

export interface UIMateParsedResponse {
  actionText: string
  actions: UIMateAction[]
  control: UIMateControl | null
  error?: string
}

export interface UIMateHistoryStep {
  /** The response returned by UI-Mate at this step. */
  response: string
  /** The short action text parsed from the response. */
  actionText: string
}

export type UIMateContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface UIMateMessage {
  role: 'system' | 'user' | 'assistant'
  content: UIMateContentBlock[]
}

export interface BuildUIMateMessagesInput {
  instruction: string
  currentScreenshotDataUrl: string
  history?: readonly UIMateHistoryStep[]
  includeThinkingInHistory?: boolean
}

const COLLAPSED_SCREENSHOT_TEXT = 'This screenshot has been collapsed.'

const ACTION_DESCRIPTION = `* \`left_click\`: Click the left mouse button at the specified (x, y) coordinate.
* \`right_click\`: Click the right mouse button at the specified (x, y) coordinate.
* \`middle_click\`: Click the middle mouse button at the specified (x, y) coordinate.
* \`double_click\`: Double-click the left mouse button at the specified (x, y) coordinate.
* \`triple_click\`: Triple-click the left mouse button at the specified (x, y) coordinate.
* \`drag\`: Click and drag the mouse cursor from its current position to the specified (x, y) coordinate.
* \`mouse_move\`: Move the cursor to the specified (x, y) coordinate without clicking.
* \`type\`: Type a specified string of text.
* \`hotkey\`: Press a combination of keys.
* \`press\`: Press a single key or a sequence of keys.
* \`key_down\`: Press and hold the specified keys.
* \`key_up\`: Release the specified keys in reverse order.
* \`scroll\`: Scroll by the specified number of pixels.
* \`wait\`: Pause execution for the specified number of seconds.
* \`call_user\`: Ask the user for information or confirmation.
* \`finished\`: Terminate the task with a success or failure status.`

export const UI_MATE_TOOL_SCHEMA = {
  type: 'function',
  function: {
    name: 'computer_use',
    description: [
      'Use a mouse and keyboard to interact with a computer, and take screenshots.',
      '* The screen resolution is normalized to 1000x1000.',
      '* Consult the current screenshot before selecting a coordinate.',
      '* Click the center of the target, not its edge.'
    ].join('\n'),
    parameters: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: UI_MATE_ACTIONS, description: ACTION_DESCRIPTION },
        coordinate: {
          type: 'array',
          description: 'The (x, y) coordinates (0-999). Required for pointer actions.'
        },
        text: { type: 'string' },
        keys: { type: 'array' },
        pixels: { type: 'number' },
        direction: { type: 'string', enum: ['vertical', 'horizontal'] },
        time: { type: 'number' },
        status: { type: 'string', enum: ['success', 'failure'] }
      }
    }
  }
} as const

const TOOL_FORMAT = `If you call a function, reply with this XML structure and no suffix:\n<tool_call>\n<function=computer_use>\n<parameter=action>\nleft_click\n</parameter>\n</function>\n</tool_call>`

export const UI_MATE_SYSTEM_PROMPT = `You are a helpful GUI agent.

# Tools

You have access to the following functions:

<tools>
${JSON.stringify(UI_MATE_TOOL_SCHEMA)}
</tools>

${TOOL_FORMAT}

# Response format

Output exactly in this order:
1. One <think>...</think> block with the progress assessment and next-action analysis.
2. One <action>...</action> block with a short imperative.
3. One or more <tool_call>...</tool_call> blocks.

Do not output a suffix. Use action=finished with status=failure when the task is infeasible.`

function instructionText(instruction: string, history: readonly UIMateHistoryStep[]): string {
  const previousActions = history.length
    ? history.map((step, index) => `Step ${index + 1}: ${step.actionText}`).join('\n')
    : 'None'
  return `\nPlease generate the next move according to the UI screenshot, instruction and previous actions.\n\nInstruction: ${instruction}\n\nPrevious actions:\n${previousActions}`
}

/**
 * Build UI-Mate messages with one and only one image: the current screenshot.
 * Prior screenshots use the official collapse marker. Prior model replies keep
 * the official compact response form.
 */
export function buildUIMateMessages(input: BuildUIMateMessagesInput): UIMateMessage[] {
  const history = (input.history ?? []).slice(-UI_MATE_MAX_HISTORY_STEPS)
  const messages: UIMateMessage[] = [
    { role: 'system', content: [{ type: 'text', text: UI_MATE_SYSTEM_PROMPT }] }
  ]

  if (history.length > 0) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: COLLAPSED_SCREENSHOT_TEXT },
        { type: 'text', text: instructionText(input.instruction, history) }
      ]
    })
    for (const [index, step] of history.entries()) {
      messages.push({
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: compactUIMateResponse(step.response, input.includeThinkingInHistory ?? true)
          }
        ]
      })
      if (index < history.length - 1) {
        messages.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text: `<tool_response>\n${COLLAPSED_SCREENSHOT_TEXT}\n</tool_response>`
            }
          ]
        })
      }
    }
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: '<tool_response>\n' },
        { type: 'image_url', image_url: { url: input.currentScreenshotDataUrl } },
        { type: 'text', text: '\n</tool_response>' }
      ]
    })
  } else {
    messages.push({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: input.currentScreenshotDataUrl } },
        { type: 'text', text: instructionText(input.instruction, history) }
      ]
    })
  }

  return messages
}

/** Keep a historical response from <think> or <action>, as the official harness does. */
export function compactUIMateResponse(response: string, includeThinking = false): string {
  const match = response.match(includeThinking ? /<think\b[^>]*>/i : /<action\b[^>]*>/i)
  return match?.index === undefined ? response : response.slice(match.index).trim()
}

function actionText(response: string): string {
  return response.match(/<action>\s*([\s\S]*?)\s*<\/action>/i)?.[1]?.trim() ?? ''
}

function toolCalls(response: string): Array<Record<string, unknown>> {
  const calls: Array<Record<string, unknown>> = []
  for (const toolMatch of response.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/gi)) {
    const body = toolMatch[1] ?? ''
    if (body.match(/<function=([^>]+)>/)?.[1] !== 'computer_use') continue
    const values: Record<string, unknown> = {}
    for (const parameter of body.matchAll(/<parameter=([^>]+)>\s*([\s\S]*?)\s*<\/parameter>/gi)) {
      const name = parameter[1] ?? ''
      const raw = (parameter[2] ?? '').trim()
      values[name] = parseParameter(raw)
    }
    calls.push(values)
  }
  return calls
}

function parseParameter(raw: string): unknown {
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  return raw
}

function isActionName(value: unknown): value is UIMateActionName {
  return typeof value === 'string' && (UI_MATE_ACTIONS as readonly string[]).includes(value)
}

function normalizedCoordinate(
  value: unknown,
  width: number,
  height: number
): [number, number] | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined
  const x = Number(value[0])
  const y = Number(value[1])
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
  return [Math.trunc((x * width) / 999), Math.trunc((y * height) / 999)]
}

function parsedAction(
  call: Record<string, unknown>,
  viewport: { width: number; height: number }
): UIMateAction | null {
  if (!isActionName(call.action)) return null
  const coordinate = normalizedCoordinate(call.coordinate, viewport.width, viewport.height)
  const keys = Array.isArray(call.keys)
    ? call.keys.filter((key): key is string => typeof key === 'string')
    : typeof call.keys === 'string'
      ? call.keys.split('+').map((key) => key.trim())
      : undefined
  const pixels = Number(call.pixels)
  const time = Number(call.time)
  return {
    action: call.action,
    ...(coordinate ? { coordinate } : {}),
    ...(typeof call.text === 'string' ? { text: call.text } : {}),
    ...(keys ? { keys } : {}),
    ...(call.pixels !== undefined && Number.isFinite(pixels) ? { pixels } : {}),
    ...(call.direction === 'vertical' || call.direction === 'horizontal'
      ? { direction: call.direction }
      : {}),
    ...(call.time !== undefined && Number.isFinite(time) ? { time } : {}),
    ...(call.status === 'success' || call.status === 'failure' ? { status: call.status } : {})
  }
}

const INFEASIBLE =
  /\b(not possible|impossible|not feasible|cannot be completed|unable to complete|not supported|requires (?:an? )?(?:extension|plugin|account|credentials|hardware))\b/i

/** Parse one official UI-Mate XML response and scale its 0-999 coordinates. */
export function parseUIMateResponse(
  response: string,
  viewport: { width: number; height: number }
): UIMateParsedResponse {
  const summary = actionText(response)
  if (!summary) {
    return { actionText: '', actions: [], control: 'FAIL', error: 'Missing <action> block.' }
  }
  const rawCalls = toolCalls(response)
  if (rawCalls.length === 0) {
    return {
      actionText: summary,
      actions: [],
      control: INFEASIBLE.test(response) ? 'FAIL' : 'DONE',
      error: 'Missing computer_use tool call.'
    }
  }
  const actions = rawCalls
    .map((call) => parsedAction(call, viewport))
    .filter((action): action is UIMateAction => action !== null)
  if (actions.length !== rawCalls.length) {
    return { actionText: summary, actions: [], control: 'FAIL', error: 'Invalid action.' }
  }

  const terminal = actions.find((action) =>
    ['wait', 'call_user', 'finished'].includes(action.action)
  )
  if (terminal?.action === 'wait') return { actionText: summary, actions: [], control: 'WAIT' }
  if (terminal?.action === 'call_user') {
    return {
      actionText: summary,
      actions: [],
      control: INFEASIBLE.test(response) ? 'FAIL' : 'DONE'
    }
  }
  if (terminal?.action === 'finished') {
    return {
      actionText: summary,
      actions: [],
      control: terminal.status === 'success' ? 'DONE' : 'FAIL'
    }
  }
  return { actionText: summary, actions, control: null }
}
