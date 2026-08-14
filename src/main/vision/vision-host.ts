/**
 * The vision rail's live host (R2-D) - the Electron shell the pure spine plugs
 * into. It captures the screen (desktopCapturer), grounds each step with the
 * local vision model, runs the guard's kill switch, and actuates through an
 * ActuationPort.
 *
 * Actuation is CAPABILITY-GATED. Synthetic mouse/keyboard needs a native addon
 * (@nut-tree-fork / robotjs) plus the Accessibility + Screen-Recording
 * entitlements and a notarization pass - a real packaging decision, not a
 * silent dependency. Until that addon is present, loadActuation() returns null,
 * visionActuationAvailable() is false, and the rail refuses cleanly ("vision
 * actuation is not available in this build") instead of half-working. The
 * computer_task TOOL is not offered to the model until the capability is there,
 * so the supervised tier is shipped labeled or not at all - never broken.
 *
 * Native/Electron glue over the tested spine (parser, guard, loop, executor),
 * so it is excluded from in-process coverage - exercised on a real display in
 * the real-machine pass, not here.
 */
import { desktopCapturer, globalShortcut, screen } from 'electron'
import { llm } from '../llm'
import type { VisionAction, Bounds } from './vision-action'
import { runVisionTask, type VisionScreen, type VisionTaskResult } from './vision-agent'
import { VisionGuard } from './vision-guard'
import { getTakeoverCoordinator } from '../browser/takeover'

/** The synthetic-input surface the host needs. Implemented by a native addon
 *  when one is installed; null otherwise. */
export interface ActuationPort {
  moveMouse(x: number, y: number): void
  click(button: 'left' | 'right', double: boolean): void
  dragTo(x: number, y: number): void
  typeText(text: string): void
  tapKeys(keys: string): void
  scroll(direction: 'up' | 'down' | 'left' | 'right'): void
}

/** Lazy-load the native actuation addon. Returns null when it is not installed
 *  - the honest state today, so callers gate on it. */
function loadActuation(): ActuationPort | null {
  // No addon is bundled yet (see the file header). When one is added, wire it
  // here behind the same interface; nothing above this line changes.
  return null
}

export function visionActuationAvailable(): boolean {
  return loadActuation() !== null
}

const VISION_SYSTEM = [
  'You are a GUI agent operating the user’s computer to complete a task.',
  'You see a screenshot each step and reply with ONE action in the UI-TARS action space:',
  "click(point='<point>x y</point>'), left_double(...), right_single(...), drag(start_box='(x,y)', end_box='(x,y)'),",
  "type(content='...'), hotkey(key='...'), scroll(point='<point>x y</point>', direction='down'), wait(), finished(content='...'), call_user(content='...').",
  'Coordinates are 0-1000 normalized. For any sign-in, password, one-time code, or payment, reply call_user - the user acts directly. Never type credentials.'
].join('\n')

function makeScreen(actuation: ActuationPort): VisionScreen {
  return {
    async capture() {
      const point = screen.getCursorScreenPoint()
      const display = screen.getDisplayNearestPoint(point)
      const { width, height } = display.size
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width, height }
      })
      const source = sources[0]
      const image = source ? source.thumbnail.toPNG().toString('base64') : ''
      return { image, bounds: { width, height } as Bounds }
    },
    async actuate(action: VisionAction) {
      dispatch(actuation, action)
    }
  }
}

function dispatch(actuation: ActuationPort, action: VisionAction): void {
  switch (action.type) {
    case 'click':
      actuation.moveMouse(action.point.x, action.point.y)
      actuation.click('left', false)
      return
    case 'double_click':
      actuation.moveMouse(action.point.x, action.point.y)
      actuation.click('left', true)
      return
    case 'right_click':
      actuation.moveMouse(action.point.x, action.point.y)
      actuation.click('right', false)
      return
    case 'drag':
      actuation.moveMouse(action.from.x, action.from.y)
      actuation.dragTo(action.to.x, action.to.y)
      return
    case 'type':
      actuation.typeText(action.content)
      return
    case 'hotkey':
      actuation.tapKeys(action.keys)
      return
    case 'scroll':
      actuation.moveMouse(action.point.x, action.point.y)
      actuation.scroll(action.direction)
      return
    default:
      return
  }
}

class VisionHost {
  async runTask(goal: string, taskId: string): Promise<VisionTaskResult> {
    const actuation = loadActuation()
    if (!actuation) {
      return {
        ok: false,
        summary: 'vision actuation is not available in this build',
        steps: [],
        handoffs: 0
      }
    }
    const guard = new VisionGuard()
    // The kill switch: Esc halts the run and consumes the keypress.
    globalShortcut.register('Escape', () => guard.halt('stopped with Esc'))
    const coordinator = getTakeoverCoordinator()
    try {
      return await runVisionTask(goal, {
        screen: makeScreen(actuation),
        guard,
        ground: (g, image) =>
          llm.chat(`${VISION_SYSTEM}\n\nTask: ${g}`, [image], 60_000, 200, {
            disableThinking: true
          }),
        waitForUser: async (why) => {
          await coordinator.waitForTakeover(taskId, why)
        }
      })
    } finally {
      globalShortcut.unregister('Escape')
    }
  }
}

let host: VisionHost | null = null

export function getVisionRailHost(): VisionHost {
  if (!host) {
    host = new VisionHost()
  }
  return host
}
