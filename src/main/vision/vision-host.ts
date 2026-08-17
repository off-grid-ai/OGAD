/**
 * The vision rail's live host (R2-D) - the Electron shell the pure spine plugs
 * into. It captures the screen (desktopCapturer), grounds each step with the
 * local vision model, runs the guard's kill switch, and actuates through an
 * ActuationPort backed by the nut.js native input addon.
 *
 * Actuation is CAPABILITY-GATED on the OPTIONAL native addon (@nut-tree-fork/
 * nut-js). When it is installed, loadActuation() returns a working port; when it
 * is absent, it returns null and the rail refuses cleanly ("vision actuation is
 * not available") instead of half-working - so an addon-less build (or a failed
 * native rebuild) degrades gracefully rather than crashing. On macOS the run
 * also needs the Accessibility grant; without it we prompt and stop with a clear
 * message rather than clicking into the void.
 *
 * Native/Electron glue over the tested spine (parser, guard, loop, executor -
 * and the pure hotkey map in vision-keys), so it is excluded from in-process
 * coverage; the actuation itself is exercised on a real machine (a display + the
 * Accessibility grant), which no headless runner has.
 */
import { desktopCapturer, globalShortcut, screen, systemPreferences } from 'electron'
import { llm } from '../llm'
import type { VisionAction, Bounds } from './vision-action'
import { runVisionTask, type VisionScreen, type VisionTaskResult } from './vision-agent'
import { VisionGuard } from './vision-guard'
import { buildVisionPrompt } from './vision-prompt'
import { hotkeyToKeyNames } from './vision-keys'
import { emitVisionState, emitVisionStep, registerVisionSession } from './vision-controller'
import { visionModelNotice } from './vision-model-notice'
import { getTakeoverCoordinator } from '../browser/takeover'

/** The synthetic-input surface the host needs. Backed by the native addon when
 *  installed; null otherwise. Async - the addon's operations are promises. */
export interface ActuationPort {
  moveMouse(x: number, y: number): Promise<void>
  click(button: 'left' | 'right', double: boolean): Promise<void>
  dragTo(x: number, y: number): Promise<void>
  typeText(text: string): Promise<void>
  tapKeys(keys: string): Promise<void>
  scroll(direction: 'up' | 'down' | 'left' | 'right'): Promise<void>
}

/** The slice of the nut.js API the adapter uses. */
interface NutApi {
  mouse: {
    setPosition(p: unknown): Promise<unknown>
    leftClick(): Promise<unknown>
    rightClick(): Promise<unknown>
    doubleClick(btn: number): Promise<unknown>
    drag(path: unknown[]): Promise<unknown>
    scrollUp(n: number): Promise<unknown>
    scrollDown(n: number): Promise<unknown>
    scrollLeft(n: number): Promise<unknown>
    scrollRight(n: number): Promise<unknown>
  }
  keyboard: {
    type(...input: unknown[]): Promise<unknown>
    pressKey(...keys: number[]): Promise<unknown>
    releaseKey(...keys: number[]): Promise<unknown>
  }
  Point: new (x: number, y: number) => unknown
  Button: { LEFT: number; RIGHT: number; MIDDLE: number }
  Key: Record<string, number>
}

/**
 * Load the OPTIONAL native input addon and adapt it to ActuationPort. The
 * require is by a variable name so the bundler/typechecker never hard-binds the
 * optional module; a missing addon (not installed, or a failed native rebuild)
 * is caught and returns null, keeping the rail gated instead of crashing.
 */
function loadActuation(): ActuationPort | null {
  let nut: NutApi
  try {
    // Require by a VARIABLE name so the bundler never statically resolves the
    // optional module (main is CJS - `require` is available at runtime); a
    // missing or unbuilt addon throws here and we fall through to null.
    const load = (m: string): NutApi => (require as NodeRequire)(m) as NutApi
    nut = load('@nut-tree-fork/nut-js')
  } catch {
    return null
  }
  const { mouse, keyboard, Point, Button, Key } = nut
  return {
    async moveMouse(x, y) {
      await mouse.setPosition(new Point(x, y))
    },
    async click(button, double) {
      if (double) {
        await mouse.doubleClick(Button.LEFT)
        return
      }
      await (button === 'right' ? mouse.rightClick() : mouse.leftClick())
    },
    async dragTo(x, y) {
      // The mouse is moved to the start first (dispatch), so a one-point path
      // drags from there to here.
      await mouse.drag([new Point(x, y)])
    },
    async typeText(text) {
      await keyboard.type(text)
    },
    async tapKeys(keys) {
      const names = hotkeyToKeyNames(keys)
      if (!names) {
        return
      }
      const codes = names.map((n) => Key[n]).filter((c) => typeof c === 'number')
      if (codes.length !== names.length) {
        return // an unmapped key - refuse the partial combo
      }
      await keyboard.pressKey(...codes)
      await keyboard.releaseKey(...codes)
    },
    async scroll(direction) {
      const steps = 3
      if (direction === 'up') {
        await mouse.scrollUp(steps)
      } else if (direction === 'down') {
        await mouse.scrollDown(steps)
      } else if (direction === 'left') {
        await mouse.scrollLeft(steps)
      } else {
        await mouse.scrollRight(steps)
      }
    }
  }
}

export function visionActuationAvailable(): boolean {
  return loadActuation() !== null
}

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
      await dispatch(actuation, action)
    }
  }
}

async function dispatch(actuation: ActuationPort, action: VisionAction): Promise<void> {
  switch (action.type) {
    case 'click':
      await actuation.moveMouse(action.point.x, action.point.y)
      await actuation.click('left', false)
      return
    case 'double_click':
      await actuation.moveMouse(action.point.x, action.point.y)
      await actuation.click('left', true)
      return
    case 'right_click':
      await actuation.moveMouse(action.point.x, action.point.y)
      await actuation.click('right', false)
      return
    case 'drag':
      await actuation.moveMouse(action.from.x, action.from.y)
      await actuation.dragTo(action.to.x, action.to.y)
      return
    case 'type':
      await actuation.typeText(action.content)
      return
    case 'hotkey':
      await actuation.tapKeys(action.keys)
      return
    case 'scroll':
      await actuation.moveMouse(action.point.x, action.point.y)
      await actuation.scroll(action.direction)
      return
    default:
      return
  }
}

/** macOS needs the Accessibility grant to post synthetic input to other apps.
 *  Returns the honest failure (prompting once) when it is missing. */
function accessibilityBlock(): VisionTaskResult | null {
  if (process.platform !== 'darwin') {
    return null
  }
  if (systemPreferences.isTrustedAccessibilityClient(true)) {
    return null
  }
  return {
    ok: false,
    summary:
      'Off Grid needs Accessibility access to control the screen. Grant it in System Settings > Privacy & Security > Accessibility, then run this again.',
    steps: [],
    handoffs: 0
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
    const blocked = accessibilityBlock()
    if (blocked) {
      return blocked
    }
    const guard = new VisionGuard()
    // The kill switch: Esc halts the run and consumes the keypress. The overlay's
    // Stop routes to the SAME guard via the controller session.
    globalShortcut.register('Escape', () => guard.halt('stopped with Esc'))
    const releaseSession = registerVisionSession(guard)
    const coordinator = getTakeoverCoordinator()
    // Model-agnostic, but honest: warn (do not block) when the loaded model is
    // not a grounder, so the user sees why a click may miss and what to load.
    const notice = visionModelNotice(llm.activeModelInfo())
    emitVisionState({ taskId, goal, status: 'running', ...(notice ? { notice } : {}) })
    try {
      const result = await runVisionTask(goal, {
        screen: makeScreen(actuation),
        guard,
        ground: (g, image) =>
          llm.chat(buildVisionPrompt(g), [image], 60_000, 200, {
            disableThinking: true
          }),
        waitForUser: async (why) => {
          await coordinator.waitForTakeover(taskId, why)
        },
        onStep: (note) => emitVisionStep(taskId, note)
      })
      emitVisionState({
        taskId,
        goal,
        status: result.ok ? 'done' : 'failed',
        summary: result.summary
      })
      return result
    } finally {
      globalShortcut.unregister('Escape')
      releaseSession()
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
