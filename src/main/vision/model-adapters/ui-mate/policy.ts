/**
 * Private TypeScript policy adapter for Tencent UI-Mate.
 *
 * Protocol source of truth (Apache-2.0), pinned to the reviewed revision:
 * https://github.com/Tencent/UI-Mate/blob/d2b2e0aede83eeacfb1bc86f66503acbc4a6738a/agents/ui_mate_agent.py
 *
 * This module translates the model protocol only. It does not own a screen,
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

export type UIMateActionName = (typeof UI_MATE_ACTIONS)[number] | 'subtask_complete'
export type UIMateControl = 'WAIT' | 'USER' | 'DONE' | 'FAIL'

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
  decisionRationale?: string
  actions: UIMateAction[]
  control: UIMateControl | null
  error?: string
}

export interface UIMateHistoryStep {
  /** The response returned by UI-Mate at this step. */
  response: string
  /** The short action text parsed from the response. */
  actionText: string
  /** Retain only the recent visual window, as the official UI-Mate harness does. */
  screenshotDataUrl?: string
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

export const UI_MATE_PROMPT_ADDITIONS = `<IMPORTANT_NOTES>
* DO NOT use LibreOffice macros or GIMP Script-Fu to complete tasks. Always use the GUI interface directly with mouse and keyboard actions. Macros and scripting cause reliability issues and task failures.
* For GIMP tasks, do NOT save or export files unless the instruction explicitly asks you to. Note that existing tasks that require file output will ask you to "export", not "save". Most GIMP tasks are evaluated automatically without requiring you to save.
* Before starting a task, consider whether it is achievable with the designated application's native GUI features. If the app fundamentally lacks the requested capability, declare it infeasible (finish with status=failure) instead of using CLI tools, Python scripts, or other applications as workarounds.
* After completing a task, verify the visible or functional result. If your actions had no real effect, reconsider whether the task is feasible.
</IMPORTANT_NOTES>`

const ACTION_DESCRIPTION = `* \`left_click\`: Click the left mouse button at the specified (x, y) coordinate.
* \`right_click\`: Click the right mouse button at the specified (x, y) coordinate.
* \`middle_click\`: Click the middle mouse button at the specified (x, y) coordinate.
* \`double_click\`: Double-click the left mouse button at the specified (x, y) coordinate.
* \`triple_click\`: Triple-click the left mouse button at a specified (x, y) coordinate.
* \`drag\`: Click and drag the mouse cursor from its current position to the specified (x, y) coordinate.
* \`mouse_move\`: Move the cursor to the specified (x, y) coordinate without clicking.
* \`type\`: Type a specified string of text.
* \`hotkey\`: Press a combination of keys (e.g., ["ctrl", "v"]).
* \`press\`: Press a single key or a sequence of keys, provided as an array of strings (e.g., ["backspace"], ["enter"], ["a", "b", "c"]).
* \`key_down\`: Press and HOLD the specified key(s) down in order (no release). Use this for stateful holds like holding Shift while clicking.
* \`key_up\`: Release the specified key(s) in reverse order.
* \`scroll\`: Scroll the mouse wheel by a specified number of pixels. Use "direction" to specify vertical (default, positive for up, negative for down) or horizontal (positive for right, negative for left) scrolling.
* \`wait\`: Pause execution for a specified number of seconds.
* \`call_user\`: Ask the user for information or confirmation. Use this when you genuinely need user input, or when the task cannot be completed (in that case clearly state why it is infeasible).
* \`finished\`: Terminate the task and indicate whether it was a 'success' or 'failure'.`

export const UI_MATE_TOOL_SCHEMA = {
  type: 'function',
  function: {
    name: 'computer_use',
    description: [
      'Use a mouse and keyboard to interact with a computer, and take screenshots.',
      '* This is an interface to a desktop GUI. You do not have access to a terminal or applications menu. You must click on desktop icons to start applications.',
      "* Some applications may take time to start or process actions, so you may need to wait and take successive screenshots to see the results of your actions. E.g. if you click on Firefox and a window doesn't open, try wait and taking another screenshot.",
      "* The screen's resolution is 1000x1000.",
      '* Whenever you intend to move the cursor to click on an element like an icon, you should consult a screenshot to determine the coordinates of the element before moving the cursor.',
      '* If you tried clicking on a program or link but it failed to load even after waiting, try adjusting your cursor position so that the tip of the cursor visually falls on the element that you want to click.',
      "* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click boxes on their edges unless asked."
    ].join('\n'),
    parameters: {
      properties: {
        action: { description: ACTION_DESCRIPTION, enum: UI_MATE_ACTIONS, type: 'string' },
        coordinate: {
          description: 'The (x, y) coordinates (0-999). Required for: clicks, mouse_move, drag.',
          type: 'array'
        },
        text: {
          description:
            'The text to type, or the message to the user. Required for `action=type` and `action=call_user`.',
          type: 'string'
        },
        keys: {
          description:
            "An array of key names (e.g. ['a'], ['ctrl', 'c']). Required for: hotkey, press, key_down, key_up.",
          type: 'array'
        },
        pixels: {
          description: 'The number of pixels to scroll. Required only for `action=scroll`.',
          type: 'number'
        },
        direction: {
          type: 'string',
          enum: ['vertical', 'horizontal'],
          description:
            "The scroll direction. 'vertical' (default) for up/down scrolling, 'horizontal' for left/right scrolling. Required only for `action=scroll`."
        },
        time: {
          description: 'Seconds to wait. Required only for `action=wait`.',
          type: 'number'
        },
        status: {
          description: 'The outcome of the task. Required only for `action=finished`.',
          type: 'string',
          enum: ['success', 'failure']
        }
      },
      required: ['action'],
      type: 'object'
    }
  }
} as const

function pythonJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(', ')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}: ${pythonJson(item)}`)
      .join(', ')}}`
  }
  return JSON.stringify(value)
}

const TOOL_FORMAT = `If you choose to call a function ONLY reply in the following format with NO suffix:

<tool_call>
<function=example_function_name>
<parameter=example_parameter_1>
value_1
</parameter>
<parameter=example_parameter_2>
This is the value for the second parameter
that can span
multiple lines
</parameter>
</function>
</tool_call>

<IMPORTANT>
Reminder:
- Function calls MUST follow the specified format: an inner <function=...></function> block must be nested within <tool_call></tool_call> XML tags
- Required parameters MUST be specified
- You may provide optional reasoning for your function call in natural language BEFORE the function call, but NOT after
- If there is no function call available, answer the question like normal with your current knowledge and do not tell the user about function calls
</IMPORTANT>`

export const UI_MATE_SYSTEM_PROMPT = `You are a helpful GUI agent.

# Tools

You have access to the following functions:

<tools>
${pythonJson(UI_MATE_TOOL_SCHEMA)}
</tools>

${TOOL_FORMAT}

${UI_MATE_PROMPT_ADDITIONS}

# Response format

Response format for every step:
1) Thought: A single <think>...</think> block containing step by step progress assessment and next action analysis.
2) Action: A single <action>...</action> block containing a short imperative describing what to do in the UI.
3) Tool Execution: A single or multiple <tool_call>...</tool_call> blocks.

Rules:
- Output exactly in the order: <think>...</think>, <action>...</action>, <tool_call>...</tool_call>.
- From a first-person perspective, systematically assess progress and errors, evaluate potential next steps, and precisely plan text inputs (cursor position and expected outcomes)
- Be brief for Action: one sentence for action description.
- Do not output anything else outside those parts.
- If finishing, use action=finished in the tool call. If the task is infeasible, finish with status=failure.`

const UI_MATE_WORKFLOW_EXTENSION = `# Execution-plan extension

The instruction contains one current execution milestone. Work only on that milestone. The following rules override the task-termination rules above:
- When the current milestone is visibly complete, return action=subtask_complete with this tool call:
<tool_call><function=computer_use><parameter=action>subtask_complete</parameter></function></tool_call>
- Never use action=finished while a current execution milestone is active.
- The execution-plan controller decides when the full task ends.
- If the milestone is blocked or infeasible, use action=call_user and explain the problem.
Do not mark the current milestone complete before its result is visible in the screenshot. Do not start a later milestone.`

function instructionText(
  instruction: string,
  previousHistory: readonly UIMateHistoryStep[]
): string {
  const previousActions = previousHistory.length
    ? previousHistory.map((step, index) => `Step ${index + 1}: ${step.actionText}`).join('\n')
    : 'None'
  return `\nPlease generate the next move according to the UI screenshot, instruction and previous actions.\n\nInstruction: ${instruction}\n\nPrevious actions:\n${previousActions}`
}

/** Build the UI-Mate trajectory with one authoritative visual frame. Prior
 * actions remain as compact text, but prior images collapse so a coordinate can
 * only refer to the current screenshot. The current frame already carries the
 * previous-click marker needed to judge the last action. */
export function buildUIMateMessages(input: BuildUIMateMessagesInput): UIMateMessage[] {
  const history = input.history ?? []
  const totalSteps = history.length + 1
  const startStep = Math.max(1, totalSteps - UI_MATE_MAX_HISTORY_STEPS)
  const priorHistory = history.slice(0, startStep - 1)
  const retainedHistory = history.slice(startStep - 1)
  const usesExecutionPlan =
    /(?:Execution plan|Current execution plan and verified progress):/i.test(input.instruction)
  const messages: UIMateMessage[] = [
    {
      role: 'system',
      content: [
        {
          type: 'text',
          text: usesExecutionPlan
            ? `${UI_MATE_SYSTEM_PROMPT}\n\n${UI_MATE_WORKFLOW_EXTENSION}`
            : UI_MATE_SYSTEM_PROMPT
        }
      ]
    }
  ]

  const turns = [
    ...retainedHistory.map((step) => ({ screenshot: undefined, step })),
    { screenshot: input.currentScreenshotDataUrl, step: null }
  ]
  for (const [index, turn] of turns.entries()) {
    const image = turn.screenshot
      ? ({ type: 'image_url', image_url: { url: turn.screenshot } } as const)
      : null
    const content: UIMateContentBlock[] =
      index === 0
        ? [
            ...(image ? [image] : []),
            { type: 'text', text: instructionText(input.instruction, priorHistory) }
          ]
        : image
          ? [
              { type: 'text', text: '<tool_response>\n' },
              image,
              { type: 'text', text: '\n</tool_response>' }
            ]
          : [
              {
                type: 'text',
                text: `<tool_response>\n${COLLAPSED_SCREENSHOT_TEXT}\n</tool_response>`
              }
            ]
    messages.push({ role: 'user', content })
    if (turn.step) {
      messages.push({
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: compactUIMateResponse(turn.step.response, input.includeThinkingInHistory ?? true)
          }
        ]
      })
    }
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

const MAX_DECISION_RATIONALE_LENGTH = 320
const SENSITIVE_RATIONALE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted]'],
  [
    /\b(api[_-]?key|access[_-]?token|authorization|password|secret)\s*[:=]\s*(?:Bearer\s+)?[^\s,;.!?]+/gi,
    '$1=[redacted]'
  ],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi, 'Bearer [redacted]'],
  [
    /\b(type|enter|paste)(\s+(?:the\s+)?(?:text|value|password|code))?\s+["'][^"']+["']/gi,
    '$1 [redacted]'
  ]
]

/** Convert UI-Mate's explicit thought block into bounded task evidence.
 * The full thought remains model-only; callers receive at most two redacted sentences. */
export function summarizeUIMateThinking(response: string): string | undefined {
  const thought = response.match(/<think\b[^>]*>\s*([\s\S]*?)\s*<\/think>/i)?.[1]
  if (!thought) return undefined
  const plain = thought
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!plain) return undefined
  const redacted = SENSITIVE_RATIONALE_PATTERNS.reduce(
    (value, [pattern, replacement]) => value.replace(pattern, replacement),
    plain
  )
  const concise = redacted.match(/.*?[.!?](?:\s+.*?[.!?])?(?=\s|$)/)?.[0] ?? redacted
  return concise.length > MAX_DECISION_RATIONALE_LENGTH
    ? `${concise.slice(0, MAX_DECISION_RATIONALE_LENGTH - 1).trimEnd()}…`
    : concise
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
  return (
    typeof value === 'string' &&
    (value === 'subtask_complete' || (UI_MATE_ACTIONS as readonly string[]).includes(value))
  )
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
  if (x < 0 || x > 999 || y < 0 || y > 999) return undefined
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return undefined
  }
  // UI-Mate is trained against a 1000 x 1000 action grid whose valid values
  // are 0..999. Keep that grid intact. Dividing by 999 shifts every non-zero
  // point and maps the last value outside the encoded image.
  return [
    Math.min(width - 1, Math.trunc((x * width) / 1000)),
    Math.min(height - 1, Math.trunc((y * height) / 1000))
  ]
}

function parsedAction(
  call: Record<string, unknown>,
  viewport: { width: number; height: number }
): UIMateAction | null {
  if (!isActionName(call.action)) return null
  const coordinate = normalizedCoordinate(call.coordinate, viewport.width, viewport.height)
  if (
    [
      'left_click',
      'right_click',
      'middle_click',
      'double_click',
      'triple_click',
      'drag',
      'mouse_move'
    ].includes(call.action) &&
    !coordinate
  ) {
    return null
  }
  const keys = parsedKeys(call.action, call.keys)
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

function cleanKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let key = value
  if (key.startsWith('keys=[')) key = key.slice(6)
  if (key.endsWith(']')) key = key.slice(0, -1)
  if (key.startsWith("['") || key.startsWith('["')) key = key.slice(2)
  if (key.endsWith("']") || key.endsWith('"]')) key = key.slice(0, -2)
  return key.trim()
}

function parsedKeys(action: UIMateActionName, raw: unknown): string[] | undefined {
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
  const expanded =
    action === 'hotkey'
      ? values.flatMap((value) =>
          typeof value === 'string' && value.includes('+') && value !== '+'
            ? value.split('+').map((key) => key.trim())
            : [value]
        )
      : values
  const cleaned = expanded.map(cleanKey)
  return cleaned.length > 0 && cleaned.every((key): key is string => key !== null)
    ? cleaned
    : undefined
}

/** Parse one official UI-Mate XML response and scale its 0-999 coordinates. */
export function parseUIMateResponse(
  response: string,
  viewport: { width: number; height: number }
): UIMateParsedResponse {
  const summary = actionText(response)
  const decisionRationale = summarizeUIMateThinking(response)
  if (!summary) {
    return { actionText: '', actions: [], control: 'FAIL', decisionRationale }
  }
  const rawCalls = toolCalls(response)
  if (rawCalls.length === 0) {
    return {
      actionText: summary,
      decisionRationale,
      actions: [],
      control: 'FAIL',
      error: 'Missing computer_use tool call.'
    }
  }
  const actions = rawCalls
    .map((call) => parsedAction(call, viewport))
    .filter((action): action is UIMateAction => action !== null)
  if (actions.length !== rawCalls.length) {
    return {
      actionText: summary,
      actions: [],
      control: 'FAIL',
      error: 'Invalid action.',
      decisionRationale
    }
  }

  const terminal = actions.find((action) =>
    ['wait', 'call_user', 'finished'].includes(action.action)
  )
  if (terminal?.action === 'wait')
    return { actionText: summary, actions: [terminal], control: 'WAIT', decisionRationale }
  if (terminal?.action === 'call_user') {
    return {
      actionText: summary,
      decisionRationale,
      actions: [terminal],
      control: 'USER'
    }
  }
  if (terminal?.action === 'finished') {
    return {
      actionText: summary,
      decisionRationale,
      actions: [],
      control: terminal.status === 'success' ? 'DONE' : 'FAIL'
    }
  }
  return { actionText: summary, actions, control: null, decisionRationale }
}
