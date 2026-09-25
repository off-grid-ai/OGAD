import type { ActuationPort } from '../input/actuation'
import type { VisionAction } from './vision-action'
import { inspectFocusedInput, type FocusedInputTarget } from './focused-input'
import { secureInputDecision } from './secure-input-policy'

export interface VisionDispatchResult {
  handoff?: string
}

/** The load-bearing execution boundary. A private value cannot reach typeText. */
export async function dispatchVisionAction(input: {
  actuation: ActuationPort
  action: VisionAction
  goal: string
  signal?: AbortSignal
  inspectFocused?: () => Promise<FocusedInputTarget>
  navigate?: (url: string) => Promise<void>
}): Promise<VisionDispatchResult> {
  const { actuation, action, goal } = input
  const ensureLive = (): void => input.signal?.throwIfAborted()
  ensureLive()
  if (action.type === 'type') {
    const target = await (input.inspectFocused ?? inspectFocusedInput)()
    ensureLive()
    const decision = secureInputDecision({ content: action.content, goal, target })
    if (decision.kind === 'handoff') return { handoff: decision.reason }
    await actuation.typeText(action.content, input.signal)
    return {}
  }

  switch (action.type) {
    case 'click':
      await actuation.moveMouse(action.point.x, action.point.y)
      ensureLive()
      await actuation.click('left', 1)
      return {}
    case 'double_click':
      await actuation.moveMouse(action.point.x, action.point.y)
      ensureLive()
      await actuation.click('left', 2)
      return {}
    case 'right_click':
      await actuation.moveMouse(action.point.x, action.point.y)
      ensureLive()
      await actuation.click('right', 1)
      return {}
    case 'middle_click':
      await actuation.moveMouse(action.point.x, action.point.y)
      ensureLive()
      await actuation.click('middle', 1)
      return {}
    case 'triple_click':
      await actuation.moveMouse(action.point.x, action.point.y)
      ensureLive()
      await actuation.click('left', 3)
      return {}
    case 'drag':
      await actuation.moveMouse(action.from.x, action.from.y)
      await actuation.dragTo(action.to.x, action.to.y)
      return {}
    case 'drag_to':
      await actuation.dragTo(action.to.x, action.to.y)
      return {}
    case 'mouse_move':
      await actuation.moveMouse(action.point.x, action.point.y)
      return {}
    case 'hotkey':
      await actuation.tapKeys(action.keys)
      return {}
    case 'press':
      await actuation.pressKeys(action.keys)
      return {}
    case 'key_down':
      await actuation.keyDown(action.keys)
      return {}
    case 'key_up':
      await actuation.keyUp(action.keys)
      return {}
    case 'scroll':
      await actuation.moveMouse(action.point.x, action.point.y)
      ensureLive()
      await actuation.scroll(action.direction)
      return {}
    case 'scroll_by':
      await actuation.scrollBy(action.axis, action.amount)
      return {}
    case 'navigate':
      if (!input.navigate) throw new Error('URL navigation is not available on this screen.')
      await input.navigate(action.url)
      return {}
    default:
      return {}
  }
}
