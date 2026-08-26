import type { VisionAction } from '../vision-action'
import { visionKeysSupported } from '../vision-keys'
import { assertUIMateModelCapabilities, UI_MATE_GGUF_REPOSITORIES } from './ui-mate/capabilities'
import {
  buildUIMateMessages,
  parseUIMateResponse,
  UI_MATE_GENERATION_CONFIG,
  type UIMateAction
} from './ui-mate/policy'
import type { VisionModelAdapter, VisionPolicyDecision } from './types'

const MAX_WAIT_MS = 30_000

function toVisionAction(action: UIMateAction): VisionAction | null {
  switch (action.action) {
    case 'left_click':
      return action.coordinate
        ? { type: 'click', point: { x: action.coordinate[0], y: action.coordinate[1] } }
        : null
    case 'right_click':
      return action.coordinate
        ? { type: 'right_click', point: { x: action.coordinate[0], y: action.coordinate[1] } }
        : null
    case 'middle_click':
      return action.coordinate
        ? { type: 'middle_click', point: { x: action.coordinate[0], y: action.coordinate[1] } }
        : null
    case 'double_click':
      return action.coordinate
        ? { type: 'double_click', point: { x: action.coordinate[0], y: action.coordinate[1] } }
        : null
    case 'triple_click':
      return action.coordinate
        ? { type: 'triple_click', point: { x: action.coordinate[0], y: action.coordinate[1] } }
        : null
    case 'drag':
      return action.coordinate
        ? { type: 'drag_to', to: { x: action.coordinate[0], y: action.coordinate[1] } }
        : null
    case 'mouse_move':
      return action.coordinate
        ? { type: 'mouse_move', point: { x: action.coordinate[0], y: action.coordinate[1] } }
        : null
    case 'type':
      return action.text === undefined ? null : { type: 'type', content: action.text }
    case 'hotkey':
      return action.keys && visionKeysSupported(action.keys)
        ? { type: 'hotkey', keys: action.keys.join(' ') }
        : null
    case 'press':
      return action.keys && visionKeysSupported(action.keys)
        ? { type: 'press', keys: action.keys }
        : null
    case 'key_down':
      return action.keys && visionKeysSupported(action.keys)
        ? { type: 'key_down', keys: action.keys }
        : null
    case 'key_up':
      return action.keys && visionKeysSupported(action.keys)
        ? { type: 'key_up', keys: action.keys }
        : null
    case 'scroll':
      return action.pixels === undefined
        ? null
        : {
            type: 'scroll_by',
            axis: action.direction ?? 'vertical',
            amount: action.pixels
          }
    default:
      return null
  }
}

function policyInstruction(input: Parameters<VisionModelAdapter['buildRequest']>[0]): string {
  return [
    input.goal,
    input.operatorEnvironment === 'embedded_browser'
      ? [
          'Coordinate frame:',
          '- The screenshot is the exact web page viewport. It does not include a browser address bar, tab strip, title bar, sidebar, or app chrome.',
          '- Return x and y from 0 to 999 over this exact screenshot: (0, 0) is its top-left pixel and (999, 999) is its bottom-right pixel.',
          '- Do not add an offset for browser controls or screen padding.',
          '- Use hotkey ALT+LEFT for Browser Back, CTRL+R to reload, or navigate with an HTTPS URL. Never click an imagined address bar.'
        ].join('\n')
      : [
          'Coordinate frame:',
          '- The screenshot is the exact current display frame.',
          '- Return x and y from 0 to 999 over this exact screenshot: (0, 0) is its top-left pixel and (999, 999) is its bottom-right pixel.',
          '- Do not add an offset for window borders, screen padding, or controls outside the screenshot.'
        ].join('\n'),
    input.currentMilestone
      ? `Current execution plan and verified progress:\nCurrent milestone: ${input.currentMilestone}`
      : '',
    input.recentSteps.length ? `Recent verified task events:\n${input.recentSteps.join('\n')}` : ''
  ]
    .filter(Boolean)
    .join('\n\n')
}

function uiMateDecision(
  response: string,
  bounds: Parameters<VisionModelAdapter['parseResponse']>[1]
): VisionPolicyDecision {
  const parsed = parseUIMateResponse(response, bounds)
  const rationale = parsed.decisionRationale
  if (parsed.error) {
    return {
      kind: 'invalid',
      actionText: parsed.actionText,
      error: parsed.error,
      decisionRationale: rationale
    }
  }
  const milestone = parsed.actions.find((action) => action.action === 'subtask_complete')
  if (milestone) {
    return {
      kind: 'phase_complete',
      actionText: parsed.actionText,
      summary: parsed.actionText || 'The current milestone is complete.',
      decisionRationale: rationale
    }
  }
  if (parsed.control === 'WAIT') {
    const seconds = parsed.actions[0]?.time ?? 0
    return {
      kind: 'wait',
      actionText: parsed.actionText,
      durationMs: Math.min(MAX_WAIT_MS, Math.max(0, seconds * 1_000)),
      decisionRationale: rationale
    }
  }
  if (parsed.control === 'USER') {
    const reason = parsed.actions[0]?.text || parsed.actionText
    return { kind: 'handoff', actionText: parsed.actionText, reason, decisionRationale: rationale }
  }
  if (parsed.control === 'DONE') {
    return {
      kind: 'done',
      actionText: parsed.actionText,
      summary: parsed.actionText || 'done',
      decisionRationale: rationale
    }
  }
  if (parsed.control === 'FAIL') {
    return {
      kind: 'failed',
      actionText: parsed.actionText,
      summary: parsed.actionText || 'UI-Mate stopped the task.',
      decisionRationale: rationale
    }
  }
  const actions = parsed.actions.map(toVisionAction)
  if (actions.some((action) => action === null)) {
    return {
      kind: 'invalid',
      actionText: parsed.actionText,
      error: 'UI-Mate returned an action that the live-screen actuator does not support.',
      decisionRationale: rationale
    }
  }
  return {
    kind: 'actions',
    actionText: parsed.actionText,
    actions: actions as VisionAction[],
    decisionRationale: rationale
  }
}

/** UI-Mate remains on its native XML computer_use protocol. */
export const uiMateAdapter: VisionModelAdapter = {
  id: 'ui-mate',
  screenshotResizeFactor: 32,
  browserCaptureScope: 'page',
  requiresLoadCapabilityGate: true,
  matches(model) {
    return (
      UI_MATE_GGUF_REPOSITORIES.some(
        (repository) => model.id.toLowerCase() === repository.toLowerCase()
      ) || /^tencent_UI-Mate-(?:9B|27B)-/i.test(model.primaryFile)
    )
  },
  assertCapabilities(model) {
    assertUIMateModelCapabilities({
      repositoryId: model.id,
      primaryFile: model.primaryFile,
      projectorFile: model.projectorFile,
      availableFiles: model.availableFiles
    })
  },
  buildRequest(input) {
    return {
      messages: buildUIMateMessages({
        instruction: policyInstruction(input),
        currentScreenshotDataUrl: input.currentScreenshotDataUrl,
        history: input.history
      }),
      maxTokens: UI_MATE_GENERATION_CONFIG.maxTokens,
      timeoutMs: 130_000,
      maxAttempts: 2,
      temperature: UI_MATE_GENERATION_CONFIG.temperature,
      topP: UI_MATE_GENERATION_CONFIG.topP
    }
  },
  parseResponse: uiMateDecision
}
