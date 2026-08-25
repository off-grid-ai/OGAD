import type { VisionAction } from '../vision-action'
import { visionKeysSupported } from '../vision-keys'
import { assertUIMateModelCapabilities, UI_MATE_GGUF_REPOSITORY } from './ui-mate/capabilities'
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
      // wait/call_user/finished are control signals, not synthetic input.
      return null
  }
}

export const uiMateAdapter: VisionModelAdapter = {
  id: 'ui-mate',
  screenshotResizeFactor: 32,
  requiresLoadCapabilityGate: true,
  matches(model) {
    return (
      model.id.toLowerCase() === UI_MATE_GGUF_REPOSITORY.toLowerCase() ||
      /^tencent_UI-Mate-9B-/i.test(model.primaryFile)
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
        instruction: input.goal,
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
  parseResponse(response, bounds): VisionPolicyDecision {
    const parsed = parseUIMateResponse(response, bounds)
    if (parsed.error) {
      return { kind: 'invalid', actionText: parsed.actionText, error: parsed.error }
    }
    if (parsed.control === 'WAIT') {
      const seconds = parsed.actions[0]?.time ?? 0
      return {
        kind: 'wait',
        actionText: parsed.actionText,
        // Product safety override: never let model output park the supervised
        // loop indefinitely. The official schema does not bound `time`.
        durationMs: Math.min(MAX_WAIT_MS, Math.max(0, seconds * 1_000))
      }
    }
    if (parsed.control === 'DONE') {
      return { kind: 'done', actionText: parsed.actionText, summary: parsed.actionText || 'done' }
    }
    if (parsed.control === 'FAIL') {
      return {
        kind: 'failed',
        actionText: parsed.actionText,
        summary: parsed.actionText || 'UI-Mate stopped the task.'
      }
    }
    const actions = parsed.actions.map(toVisionAction)
    if (actions.some((action) => action === null)) {
      return {
        kind: 'invalid',
        actionText: parsed.actionText,
        error: 'UI-Mate returned an action that the live-screen actuator does not support.'
      }
    }
    return {
      kind: 'actions',
      actionText: parsed.actionText,
      actions: actions as VisionAction[]
    }
  }
}
