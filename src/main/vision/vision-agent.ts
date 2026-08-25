/**
 * The vision loop (R2-D): screenshot -> ground -> actuate, under the guard,
 * until the model reports finished, calls the user, or the guard stops it.
 * The supervised tier - every actuation is on the user's live desktop, so the
 * guard (kill switch, pause-on-input, step budget) gates each one and the user
 * always overrides.
 *
 * Every boundary is injected - the screen (capture + actuate), the grounding
 * model (ground), the guard, and the takeover wait - so the loop's control
 * flow is fully unit-tested without a display: what it actuates, what it
 * refuses, when it pauses, when it stops.
 */
import type { VisionAction, Bounds } from './vision-action'
import { parseVisionAction } from './vision-action'
import type { VisionGuard } from './vision-guard'

export interface VisionScreen {
  /** A screenshot as a base64 PNG, with the pixel bounds it was captured at. */
  capture(): Promise<{ image: string; bounds: Bounds }>
  /** Perform one grounded action on the live desktop. */
  actuate(action: VisionAction): Promise<void>
}

export interface VisionTaskDeps {
  screen: VisionScreen
  guard: VisionGuard
  /** The grounding model: the goal + a screenshot in, one UI-TARS action out. */
  ground: (goal: string, image: string, history: string[]) => Promise<string>
  /** Parks until the user finishes a call_user handoff. */
  waitForUser: (why: string) => Promise<void>
  onStep?: (note: string) => void
}

export interface VisionTaskResult {
  ok: boolean
  summary: string
  steps: string[]
  handoffs: number
}

const HISTORY_TAIL = 6

export function buildGroundingHistory(steps: string[]): string[] {
  return steps.slice(-HISTORY_TAIL)
}

/* eslint-disable complexity -- one supervised state machine; per-verb helpers
   would hide the guard/pause/stop control flow the tests pin down. */
export async function runVisionTask(goal: string, deps: VisionTaskDeps): Promise<VisionTaskResult> {
  const { screen, guard, ground, waitForUser, onStep } = deps
  const steps: string[] = []
  let handoffs = 0
  const note = (line: string): void => {
    steps.push(line)
    onStep?.(line)
  }

  for (;;) {
    if (!guard.canActuate()) {
      const { state, reason } = guard.snapshot()
      if (state === 'paused') {
        // The user took over. Wait for them, then re-observe from wherever
        // they left the screen.
        note(`paused: ${reason}`)
        await waitForUser(reason)
        guard.resume()
        note('resumed by the user')
        continue
      }
      note(`stopped: ${reason}`)
      return { ok: false, summary: reason, steps, handoffs }
    }

    const shot = await screen.capture()
    const action = parseVisionAction(
      await ground(goal, shot.image, buildGroundingHistory(steps)),
      shot.bounds
    )
    if (!action) {
      note('model action did not parse; re-observing')
      continue
    }
    if (action.type === 'finished') {
      note(`done: ${action.content}`)
      return { ok: true, summary: action.content || 'done', steps, handoffs }
    }
    if (action.type === 'call_user') {
      handoffs += 1
      note(`handoff: ${action.content}`)
      await waitForUser(action.content)
      note('resumed by the user')
      continue
    }
    // A real actuation: re-check the guard right before dispatch (the user may
    // have hit Esc since canActuate above), then count the step.
    if (!guard.canActuate()) {
      continue
    }
    await screen.actuate(action)
    guard.countStep()
    note(describeAction(action))
  }
}
/* eslint-enable complexity */

function describeAction(action: VisionAction): string {
  switch (action.type) {
    case 'click':
    case 'double_click':
    case 'right_click':
      return `${action.type} at (${action.point.x}, ${action.point.y})`
    case 'drag':
      return `drag (${action.from.x}, ${action.from.y}) -> (${action.to.x}, ${action.to.y})`
    case 'type':
      return `type ${JSON.stringify(action.content.slice(0, 40))}`
    case 'hotkey':
      return `hotkey ${action.keys}`
    case 'scroll':
      return `scroll ${action.direction} at (${action.point.x}, ${action.point.y})`
    case 'wait':
      return 'wait'
    default:
      return action.type
  }
}
