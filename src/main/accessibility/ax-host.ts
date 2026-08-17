/**
 * The accessibility rail's live host (R5 T1d) - the Electron shell the tested
 * element loop plugs into. It resolves the target app, reads that app's
 * interactive elements through the shipped Swift helper (`text-extractor
 * --elements <app>`), and drives it with synthetic input - one step at a time,
 * the model picking elements by LABEL, so a normal chat model runs it with NO
 * grounder loaded.
 *
 * This is the cheapest tier: the app already publishes its controls over
 * Accessibility, so there is no screenshot, no vision model, no per-pixel
 * grounding. The router (ax-router) decides whether the tree is rich enough;
 * when it is not, the caller falls through to vision.
 *
 * Native/Electron glue over the tested spine (parser, router, loop, target
 * picker), so it is excluded from in-process coverage; it is exercised on a
 * real machine with the Accessibility grant.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { globalShortcut, systemPreferences } from 'electron'
import { binRoots, exe } from '../runtime-env'
import { llm } from '../llm'
import { loadActuation, type ActuationPort } from '../input/actuation'
import { parseAxElements, type AxElement, type AxSnapshot } from './ax-elements'
import { pickTargetApp } from './ax-target'
import {
  ELEMENT_STEP_FORMAT,
  runElementTask,
  type ElementActuator,
  type ElementTaskResult
} from './ax-agent'
import { VisionGuard } from '../vision/vision-guard'
import { emitVisionState, emitVisionStep, registerVisionSession } from '../vision/vision-controller'

const execFileAsync = promisify(execFile)

/** The product name, which must never be the target app (it is frontmost when
 *  the user approves the task). */
const SELF_APP_NAME = 'Off Grid AI Desktop'

/** Thrown when the kill switch (Esc / overlay Stop) halts a run mid-action so
 *  the loop unwinds instead of actuating again. */
class HaltError extends Error {}

function helperPath(): string | null {
  for (const root of binRoots()) {
    const candidate = path.join(root, exe('text-extractor'))
    try {
      if (fs.existsSync(candidate)) {
        return candidate
      }
    } catch {
      /* keep looking */
    }
  }
  return null
}

/** The foreground (.regular) running apps, from the helper's NSWorkspace list.
 *  This needs no Screen-Recording grant (get-windows under-reports without it),
 *  so target resolution sees every real app the user could mean. */
async function runningAppNames(helper: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(helper, ['--apps'], { timeout: 4_000 })
    return stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  } catch {
    return []
  }
}

/** Bring the target app forward so synthetic clicks land on it. `open -a` needs
 *  no automation grant (unlike osascript), so it never trips a TCC prompt. */
async function activateApp(appName: string): Promise<void> {
  try {
    await execFileAsync('open', ['-a', appName], { timeout: 3_000 })
  } catch {
    /* best effort - the read still works by name; a miss just means the app was
       already frontmost or could not be resolved by open. */
  }
}

/** Read one named app's interactive elements, or null when the helper is
 *  missing / errors / the platform is not macOS. */
async function snapshotApp(appName: string): Promise<AxSnapshot | null> {
  if (process.platform !== 'darwin') {
    return null
  }
  const helper = helperPath()
  if (!helper) {
    return null
  }
  try {
    const { stdout } = await execFileAsync(helper, ['--elements', appName], {
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024
    })
    return parseAxElements(stdout)
  } catch {
    return null
  }
}

function makeElementActuator(actuation: ActuationPort, guard: VisionGuard): ElementActuator {
  const ensureLive = (): void => {
    if (guard.isHalted) {
      throw new HaltError(guard.snapshot().reason || 'stopped')
    }
    guard.countStep()
  }
  const clickCenter = async (el: AxElement): Promise<void> => {
    await actuation.moveMouse(el.cx, el.cy)
    await actuation.click('left', false)
  }
  return {
    async click(el) {
      ensureLive()
      await clickCenter(el)
    },
    async press(el) {
      // nut.js has no portable AXPress; a click at the element's center is the
      // reliable actuation and is what its coordinates are for.
      ensureLive()
      await clickCenter(el)
    },
    async type(el, text) {
      ensureLive()
      await clickCenter(el)
      await actuation.typeText(text)
    },
    async keys(combo) {
      ensureLive()
      await actuation.tapKeys(combo)
    }
  }
}

/** What the router needs to decide the tier: the resolved app + its snapshot,
 *  or null when the goal names no drivable running app. */
export interface AxRouting {
  app: string
  snapshot: AxSnapshot
}

class AxRailHost {
  /** Resolve the target app from the goal and read its elements, for the router
   *  to score. Null => no named running app => the caller falls to vision. */
  async routingSnapshot(goal: string): Promise<AxRouting | null> {
    if (process.platform !== 'darwin') {
      return null
    }
    const helper = helperPath()
    if (!helper) {
      return null
    }
    const app = pickTargetApp(goal, await runningAppNames(helper), SELF_APP_NAME)
    if (!app) {
      return null
    }
    const snapshot = await snapshotApp(app)
    if (!snapshot) {
      return null
    }
    return { app, snapshot }
  }

  /** Drive `app` toward `goal` over the accessibility rail. `initial` is the
   *  routing snapshot already taken, reused for the first step. */
  async runTask(
    goal: string,
    taskId: string,
    app: string,
    initial?: AxSnapshot
  ): Promise<ElementTaskResult> {
    const actuation = loadActuation()
    if (!actuation) {
      return { ok: false, summary: 'input actuation is not available in this build', steps: [] }
    }
    if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(true)) {
      return {
        ok: false,
        summary:
          'Off Grid needs Accessibility access to control the screen. Grant it in System Settings > Privacy & Security > Accessibility, then run this again.',
        steps: []
      }
    }
    await activateApp(app)
    const guard = new VisionGuard()
    // The kill switch: Esc halts for good. The overlay's Stop routes to the SAME
    // guard through the controller session, so both paths end one run.
    globalShortcut.register('Escape', () => guard.halt('stopped with Esc'))
    const releaseSession = registerVisionSession(guard)
    // The AX rail is model-agnostic and needs no grounder, so there is no
    // grounder notice here (unlike the vision rail).
    emitVisionState({ taskId, goal, status: 'running' })
    let usedInitial = false
    try {
      const result = await runElementTask(goal, {
        read: async () => {
          if (!usedInitial && initial) {
            usedInitial = true
            return initial
          }
          // Read the target app BY NAME each step - stable even though Off Grid
          // (or the overlay) may hold system focus.
          return (await snapshotApp(app)) ?? { windowTitle: '', elements: [] }
        },
        actuator: makeElementActuator(actuation, guard),
        decide: (prompt) =>
          llm.chat(prompt, [], 60_000, 200, {
            responseFormat: ELEMENT_STEP_FORMAT,
            disableThinking: true
          }),
        onStep: (note) => emitVisionStep(taskId, note)
      })
      emitVisionState({
        taskId,
        goal,
        status: result.ok ? 'done' : 'failed',
        summary: result.summary
      })
      return result
    } catch (error) {
      const summary =
        error instanceof HaltError
          ? error.message || 'stopped'
          : error instanceof Error
            ? error.message
            : 'accessibility run failed'
      emitVisionState({ taskId, goal, status: 'failed', summary })
      return { ok: false, summary, steps: [] }
    } finally {
      globalShortcut.unregister('Escape')
      releaseSession()
    }
  }
}

let host: AxRailHost | null = null

export function getAxRailHost(): AxRailHost {
  if (!host) {
    host = new AxRailHost()
  }
  return host
}
