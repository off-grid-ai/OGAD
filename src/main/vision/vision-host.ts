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
import fs from 'fs'
import os from 'os'
import path from 'path'
import { desktopCapturer, globalShortcut, screen, systemPreferences } from 'electron'
import { llm } from '../llm'
import type { VisionAction, Bounds } from './vision-action'
import { runVisionTask, type VisionScreen, type VisionTaskResult } from './vision-agent'
import { VisionGuard } from './vision-guard'
import { buildVisionPrompt } from './vision-prompt'
import { emitVisionState, emitVisionStep, registerVisionSession } from './vision-controller'
import { visionModelNotice } from './vision-model-notice'
import { getTakeoverCoordinator } from '../browser/takeover'
import { loadActuation, actuationAvailable, type ActuationPort } from '../input/actuation'

export type { ActuationPort }

/** Back-compat alias: the rail-neutral availability check now lives in the
 *  shared actuation module (both vision and the accessibility rail use it). */
export function visionActuationAvailable(): boolean {
  return actuationAvailable()
}

// The screenshot is written to ONE reused temp file per process; llm.chat reads
// images off disk (decodeImages -> fs.readFileSync), NOT as base64, so the
// grounder must be handed a PATH. Captures are sequential (capture -> ground ->
// actuate), so reusing one path is race-free and keeps the disk clean.
const CAPTURE_FILE = path.join(os.tmpdir(), 'offgrid-vision-capture.png')

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
      if (source) {
        fs.writeFileSync(CAPTURE_FILE, source.thumbnail.toPNG())
      }
      // Return the file path - the grounder reads it from disk.
      return { image: CAPTURE_FILE, bounds: { width, height } as Bounds }
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
