/**
 * The accessibility rail's live host (R5 T1d) - the Electron shell the tested
 * element loop plugs into. It resolves the target app, reads that app's
 * interactive elements through the shipped Swift helper (`text-extractor
 * --elements <app>`), and drives it with synthetic input - one step at a time,
 * the model picking elements by LABEL, so a normal chat model runs it with NO
 * grounder loaded.
 *
 * This is the cheapest tier: the app publishes controls over Accessibility, so
 * there is no vision-model or per-pixel grounding. A display frame is still
 * recorded for user supervision and evidence. The router (ax-router) decides
 * whether the tree is rich enough; when it is not, the caller falls through to vision.
 *
 * Native/Electron glue over the tested spine (parser, router, loop, target
 * picker), so it is excluded from in-process coverage; it is exercised on a
 * real machine with the Accessibility grant.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { globalShortcut, systemPreferences } from 'electron'
import { llm } from '../llm'
import { loadActuation, type ActuationPort } from '../input/actuation'
import { parseAxElements, type AxElement, type AxSnapshot } from './ax-elements'
import { windowsAxBackend, type AxBackend } from './ax-win'
import { namesWebsite } from '../tools/planner-logic'
import {
  ELEMENT_STEP_FORMAT,
  runElementTask,
  type ElementActuator,
  type ElementTaskResult
} from './ax-agent'
import { VisionGuard } from '../vision/vision-guard'
import {
  emitVisionState,
  emitVisionStep,
  registerVisionSession,
  stopVisionTask,
  waitForVisionUser
} from '../vision/vision-controller'
import { showSupervisorWindow, hideSupervisorWindow } from '../vision/supervisor-window'
import { getComputerUseSettings } from '../computer-use-settings'
import { resolveComputerUseContextTokens } from '../../shared/computer-use-settings'
import { recentVisualFacts } from '../vision/visual-context'
import { recordTaskRun } from '../tasks/task-history'
import { persistAxFrame, persistAxObservation, type AxObservationFrame } from './ax-observation'
import { AxScreenCaptureError, captureAxObservationFrame } from './ax-frame'
import { accessibilityHelperPath } from './ax-helper'
import { encodeTaskPhase } from '../../shared/task-execution-plan'
import { prepareTaskExecutionPlan } from '../tasks/task-execution-plan-service'
import { registerTaskGuideHandler } from '../tasks/task-guide'
import { resolveModelIdentity } from '../models-manager'
import { NativeAppTargeter } from './native-app-target'
import { createMacNativeAppPlatform } from './native-app-macos'
import { windowsNativeAppPlatform } from './native-app-windows'
import { automationTaskReadStatus } from '@offgrid/automation'

const execFileAsync = promisify(execFile)

/** The product name, which must never be the target app (it is frontmost when
 *  the user approves the task). */
const SELF_APP_NAME = 'Off Grid AI Desktop'

/** Thrown when the kill switch (Esc / overlay Stop) halts a run mid-action so
 *  the loop unwinds instead of actuating again. */
class HaltError extends Error {}

/** The macOS backend: the Swift `text-extractor` helper (NSWorkspace apps +
 *  AX element tree) and `open -a` to foreground. Available only when the helper
 *  is present on macOS. */
const macAxBackend: AxBackend = {
  available: () => process.platform === 'darwin' && accessibilityHelperPath() !== null,
  async listApps() {
    const helper = accessibilityHelperPath()
    return helper ? createMacNativeAppPlatform(helper).listRunning() : []
  },
  snapshot: snapshotApp
}

/** The accessibility backend for this platform - the ONE place the OS is chosen.
 *  macOS uses the Swift AX helper; Windows uses PowerShell + UI Automation; any
 *  other platform gets the mac backend, whose available() is false, so the rail
 *  stays off and the caller falls to vision. */
function axBackend(): AxBackend {
  return process.platform === 'win32' ? windowsAxBackend : macAxBackend
}

function nativeAppTargeter(): NativeAppTargeter | null {
  if (process.platform === 'win32') {
    return new NativeAppTargeter(windowsNativeAppPlatform, { selfName: SELF_APP_NAME })
  }
  if (process.platform === 'darwin') {
    const helper = accessibilityHelperPath()
    return helper
      ? new NativeAppTargeter(createMacNativeAppPlatform(helper), { selfName: SELF_APP_NAME })
      : null
  }
  return null
}

/** Read one named app's interactive elements, or null when the helper is
 *  missing / errors / the platform is not macOS. */
async function snapshotApp(appName: string): Promise<AxSnapshot | null> {
  if (process.platform !== 'darwin') {
    return null
  }
  const helper = accessibilityHelperPath()
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

function makeElementActuator(
  actuation: ActuationPort,
  guard: VisionGuard,
  onAction: (action: string) => void
): ElementActuator {
  const ensureLive = async (): Promise<void> => {
    if (guard.isPaused) await guard.waitUntilRunnable()
    if (!guard.canActuate()) {
      throw new HaltError(guard.snapshot().reason || 'stopped')
    }
    guard.countStep()
  }
  const clickCenter = async (el: AxElement): Promise<void> => {
    await actuation.moveMouse(el.cx, el.cy)
    await actuation.click('left', 1)
  }
  return {
    async click(el) {
      await ensureLive()
      onAction(`Click ${el.name || el.role}`)
      await clickCenter(el)
    },
    async press(el) {
      // nut.js has no portable AXPress; a click at the element's center is the
      // reliable actuation and is what its coordinates are for.
      await ensureLive()
      onAction(`Press ${el.name || el.role}`)
      await clickCenter(el)
    },
    async type(el, text) {
      await ensureLive()
      onAction(el ? `Type in ${el.name || el.role}` : 'Type in the focused field')
      // With a target, focus it first; without one, type into the focused field.
      if (el) {
        await clickCenter(el)
      }
      await actuation.typeText(text)
    },
    async keys(combo) {
      await ensureLive()
      onAction(`Press ${combo}`)
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
  /** Resolve or launch the target app and read its elements for the router.
   * Null means no verified application target or no accessible live window. */
  async routingSnapshot(goal: string): Promise<AxRouting | null> {
    const backend = axBackend()
    if (!backend.available()) {
      return null
    }
    // A web goal must never drive a native app (a word like 'music' matching the
    // Music app is a false target) - the browser rail handles websites.
    if (namesWebsite(goal)) {
      return null
    }
    const targeter = nativeAppTargeter()
    const target = targeter ? await targeter.resolve(goal) : null
    if (!target) {
      return null
    }
    const ready = await targeter!.ensureReady(target)
    if (!ready) return null
    const app = ready.runningName
    const snapshot = await backend.snapshot(app)
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
    initial?: AxSnapshot,
    journeyId = taskId
  ): Promise<ElementTaskResult> {
    console.log(`[ax-rail] runTask app="${app}" goal="${goal}"`)
    const actuation = loadActuation()
    if (!actuation) {
      console.log('[ax-rail] BLOCKED: nut.js actuation not available in this build')
      return { ok: false, summary: 'input actuation is not available in this build', steps: [] }
    }
    if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(true)) {
      console.log('[ax-rail] BLOCKED: Accessibility grant missing for Off Grid AI')
      return {
        ok: false,
        summary:
          'Off Grid AI needs Accessibility access to control the screen. Grant it in System Settings > Privacy & Security > Accessibility, then run this again.',
        steps: []
      }
    }
    const guard = new VisionGuard({ taskId, kind: 'computer_use' })
    const request = new AbortController()
    const settings = getComputerUseSettings()
    const activeModel = llm.activeModelInfo()
    const modelIdentity = activeModel ? await resolveModelIdentity(activeModel.id) : undefined
    const contextTokens = resolveComputerUseContextTokens(
      settings.context,
      llm.effectiveContextSize()
    )
    const retrievedFacts = settings.retrieveOlderVisuals ? recentVisualFacts(taskId) : []
    // The kill switch: Esc halts for good. The overlay's Stop routes to the SAME
    // guard through the controller session, so both paths end one run.
    const escapeRegistered = globalShortcut.register('Escape', () => {
      stopVisionTask(taskId, 'stopped with Esc', 'Stopped with Esc')
    })
    const releaseSession = registerVisionSession(taskId, guard, request)
    // The AX rail is model-agnostic and needs no grounding-model notice.
    emitVisionState({
      taskId,
      journeyId,
      ...modelIdentity,
      goal,
      status: 'running',
      phase: 'preparing',
      currentStep: 0,
      currentAction: `Preparing to control ${app}`,
      ...(escapeRegistered
        ? {}
        : { notice: 'Esc is unavailable. Use Stop or Take Over in the task controls.' })
    })
    // Float the supervisor window over the app we are about to drive, so the
    // user sees the step feed even though the driven app takes the foreground.
    showSupervisorWindow()
    let usedInitial = false
    let liveStep = 0
    let captureNumber = 0
    let observationFrame: AxObservationFrame | undefined
    const queuedGuidance: string[] = []
    const releaseGuidance = registerTaskGuideHandler(taskId, (text) => {
      queuedGuidance.push(text)
      return true
    })
    try {
      const plan = await prepareTaskExecutionPlan(
        { goal, surface: 'computer', targetLabel: app, signal: request.signal },
        (marker) => emitVisionStep(taskId, marker)
      )
      const result = await runElementTask(goal, {
        read: async () => {
          emitVisionState({
            taskId,
            journeyId,
            goal,
            status: 'running',
            phase: 'observing',
            currentStep: liveStep + 1,
            currentAction: `Reading ${app}`
          })
          let snapshot: AxSnapshot
          if (!usedInitial && initial) {
            usedInitial = true
            snapshot = initial
          } else {
            // Read the target app BY NAME each step - stable even though Off Grid AI
            // (or the overlay) may hold system focus.
            snapshot = (await axBackend().snapshot(app)) ?? { windowTitle: '', elements: [] }
          }
          captureNumber += 1
          observationFrame = await captureAxObservationFrame({
            taskId,
            journeyId,
            goal,
            currentStep: liveStep + 1,
            captureNumber,
            snapshot,
            signal: request.signal
          })
          // The next model/progress update prunes unreferenced task images.
          // Reference this frame first so the live view can load it while the
          // model decides and after the task completes.
          persistAxFrame({ taskId, journeyId, title: goal, frame: observationFrame })
          return snapshot
        },
        actuator: makeElementActuator(actuation, guard, (action) => {
          emitVisionState({
            taskId,
            journeyId,
            goal,
            status: 'running',
            phase: 'acting',
            currentStep: liveStep,
            currentAction: action
          })
        }),
        decide: async (prompt) => {
          liveStep += 1
          emitVisionState({
            taskId,
            journeyId,
            goal,
            status: 'running',
            phase: 'thinking',
            currentStep: liveStep,
            currentAction: 'Choosing the next action'
          })
          const raw = await llm.chat(prompt, [], 60_000, 400, {
            responseFormat: ELEMENT_STEP_FORMAT,
            disableThinking: true,
            signal: request.signal
          })
          console.log(`[ax-rail] model reply: ${JSON.stringify(raw.slice(0, 400))}`)
          return raw
        },
        onStep: (note) => {
          console.log(`[ax-rail] step: ${note}`)
          emitVisionStep(taskId, note)
          emitVisionState({
            taskId,
            journeyId,
            goal,
            status: 'running',
            phase: 'checking',
            currentStep: liveStep,
            currentAction: note
          })
        },
        plan,
        onPhase: (phaseId) => emitVisionStep(taskId, encodeTaskPhase(phaseId)),
        takeGuidance: () => queuedGuidance.splice(0),
        waitForUser: (why, signal) => waitForVisionUser(taskId, why, signal),
        signal: request.signal,
        control: guard,
        contextTokens,
        checkpointInterval: settings.checkpointInterval,
        retrievedFacts,
        onCheckpoint: () => {
          // Action-loop checkpoints do not include plan and phase markers.
          // Keep the canonical trace already stored by emitVisionStep.
          recordTaskRun({ taskId, kind: 'computer_use', title: goal })
        },
        onObservation: (observation) => {
          persistAxObservation(taskId, goal, { ...observation, frame: observationFrame })
        }
      })
      if (!result.ok && !guard.isHalted) guard.fail(result.summary)
      const finalStatus = automationTaskReadStatus(guard.automationStatus)
      emitVisionState({
        taskId,
        journeyId,
        goal,
        status: finalStatus,
        phase:
          finalStatus === 'done' ? 'complete' : finalStatus === 'failed' ? 'failed' : 'stopped',
        currentStep: liveStep,
        currentAction: result.summary,
        summary: result.summary
      })
      return result
    } catch (error) {
      const summary = guard.isHalted
        ? guard.snapshot().reason || 'stopped'
        : error instanceof HaltError
          ? error.message || 'stopped'
          : error instanceof Error
            ? error.message
            : 'accessibility run failed'
      if (!guard.isHalted) guard.fail(summary)
      const finalStatus = automationTaskReadStatus(guard.automationStatus)
      // The capture coordinator already projected its precise terminal recovery
      // state. Keep one writer for that state instead of replacing it here.
      if (!(error instanceof AxScreenCaptureError)) {
        emitVisionState({
          taskId,
          journeyId,
          goal,
          status: finalStatus,
          phase: finalStatus === 'failed' ? 'failed' : 'stopped',
          currentStep: liveStep,
          currentAction: summary,
          summary
        })
      }
      return { ok: false, summary, steps: [] }
    } finally {
      releaseGuidance()
      if (escapeRegistered) globalShortcut.unregister('Escape')
      releaseSession()
      hideSupervisorWindow()
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
