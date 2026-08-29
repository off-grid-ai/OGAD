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
import sharp from 'sharp'
import { globalShortcut, screen } from 'electron'
import { llm } from '../llm'
import type { VisionAction, Bounds } from './vision-action'
import { type VisionScreen, type VisionTaskResult } from './vision-agent'
import { VisionGuard } from './vision-guard'
import {
  emitVisionState,
  emitVisionStep,
  registerVisionSession,
  stopVisionTask
} from './vision-controller'
import { showSupervisorWindow, hideSupervisorWindow } from './supervisor-window'
import { visionModelNotice } from './vision-model-notice'
import { getTakeoverCoordinator } from '../browser/takeover'
import { loadActuation, actuationAvailable, type ActuationPort } from '../input/actuation'
import { checkAccessibilityPermission, checkScreenRecordingPermission } from '../permissions'
import { mapActionToScreen, type DisplayGeometry } from '../input/coordinate-mapping'
import {
  appendComputerUseStepDetail,
  getTaskExecutionDevice,
  recordTaskRun,
  taskScreenshotPath
} from '../tasks/task-history'
import { getComputerUseSettings } from '../computer-use-settings'
import {
  resolveComputerUseContextTokens,
  SCREENSHOT_MAX_EDGE,
  SCREENSHOT_RESIZE_KERNEL,
  type ComputerUseSettings
} from '../../shared/computer-use-settings'
import {
  alignPixelSize,
  planAspectPreservingResize,
  type ScreenshotGeometry
} from './screenshot-geometry'
import { recentVisualFacts } from './visual-context'
import { resolveVisionModelAdapterForStrategy } from './model-adapters'
import type { VisionModelAdapter } from './model-adapters/types'
import { retryPlanningGoal, type TaskRetryCheckpoint } from '../tasks/task-retry'
import { dispatchVisionAction } from './vision-actuation'
import { encodeTaskPhase } from '../../shared/task-execution-plan'
import { prepareTaskExecutionPlan } from '../tasks/task-execution-plan-service'
import { registerTaskGuideHandler } from '../tasks/task-guide'
import { createVisionGrounder } from './vision-policy-runner'
import { resolveModelIdentity } from '../models-manager'
import { computerUsePermissionBlock } from './computer-use-permissions'
import { runVisionTaskGraph } from './vision-task-graph'
import { captureComputerUseDisplay } from './computer-use-display-capture'

export type { ActuationPort }

/** Back-compat alias: the rail-neutral availability check now lives in the
 *  shared actuation module (both vision and the accessibility rail use it). */
export function visionActuationAvailable(): boolean {
  return actuationAvailable()
}

function makeScreen(input: {
  actuation: ActuationPort
  taskId: string
  journeyId: string
  goal: string
  settings: ComputerUseSettings
  screenshotResizeFactor?: number
}): VisionScreen {
  const { actuation, taskId, journeyId, goal, settings, screenshotResizeFactor } = input
  // The display the last screenshot was taken from. Its scaleFactor + origin move
  // the grounder's DIP coordinates into the actuation space (physical px on
  // Windows). capture() always runs before actuate() in the vision loop.
  let capturedDisplay: DisplayGeometry | null = null
  let capturedGeometry: ScreenshotGeometry | null = null
  let captureNumber = 0
  return {
    async capture() {
      const point = screen.getCursorScreenPoint()
      const display = screen.getDisplayNearestPoint(point)
      const { width, height } = display.size
      const captureSize = {
        width: Math.max(1, Math.round(width * display.scaleFactor)),
        height: Math.max(1, Math.round(height * display.scaleFactor))
      }
      capturedDisplay = {
        bounds: display.bounds,
        scaleFactor: display.scaleFactor,
        ...(process.platform === 'win32'
          ? {
              physicalOrigin: screen.dipToScreenPoint({ x: display.bounds.x, y: display.bounds.y })
            }
          : {})
      }
      // Capture can return no pixels while the system is busy (for example, after a model swap).
      // Retry the one native capture owner, which excludes the supervisor before pixels exist.
      let png: Buffer | null = null
      let encodedSize: { width: number; height: number } | null = null
      for (let attempt = 0; attempt < 4 && (png === null || png.length === 0); attempt += 1) {
        try {
          const captured = await captureComputerUseDisplay({
            displayId: Number(display.id),
            ...captureSize
          })
          const sourceSize = { width: captured.width, height: captured.height }
          const plannedTarget = planAspectPreservingResize(
            sourceSize,
            SCREENSHOT_MAX_EDGE[settings.screenshotSize]
          ).encodedSize
          const target = screenshotResizeFactor
            ? alignPixelSize(plannedTarget, screenshotResizeFactor)
            : plannedTarget
          png =
            target.width === sourceSize.width && target.height === sourceSize.height
              ? captured.png
              : await sharp(captured.png)
                  .resize({
                    ...target,
                    kernel: SCREENSHOT_RESIZE_KERNEL[settings.screenshotQuality]
                  })
                  .png()
                  .toBuffer()
          encodedSize = target
        } catch {
          png = null
        }
        if (png === null || png.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      }
      if (png === null || png.length === 0) {
        throw new Error(
          'screen capture returned an empty image - check Screen Recording permission for Off Grid AI'
        )
      }
      if (!encodedSize) {
        throw new Error('screen capture returned invalid dimensions')
      }
      capturedGeometry = {
        sourceBounds: { x: 0, y: 0, width, height },
        encodedSize,
        scale: Math.min(encodedSize.width / width, encodedSize.height / height)
      }
      captureNumber += 1
      const savedScreenshot = taskScreenshotPath(taskId, captureNumber)
      fs.writeFileSync(savedScreenshot, png)
      const executionDevice = getTaskExecutionDevice()
      recordTaskRun({
        taskId,
        journeyId,
        kind: 'computer_use',
        title: goal,
        screenshotPath: savedScreenshot,
        screenshotDeviceId: executionDevice.id
      })
      // Return the file path - the grounder reads it from disk.
      return {
        image: savedScreenshot,
        bounds: encodedSize as Bounds,
        metadata: { path: savedScreenshot, geometry: capturedGeometry }
      }
    },
    async actuate(action: VisionAction) {
      const mapped =
        capturedDisplay && capturedGeometry
          ? mapActionToScreen(action, {
              display: capturedDisplay,
              platform: process.platform,
              screenshot: capturedGeometry
            })
          : action
      if (!mapped) {
        throw new Error('model returned a point outside the current screenshot')
      }
      const result = await dispatchVisionAction({ actuation, action: mapped, goal })
      return result.handoff ? result : { mappedAction: mapped }
    }
  }
}

/** Fail before model loading when macOS cannot capture or control the screen. */
function permissionBlock(): VisionTaskResult | null {
  const summary = computerUsePermissionBlock({
    platform: process.platform,
    // Prompt for the Accessibility grant so the block message is actionable.
    accessibilityGranted: checkAccessibilityPermission(true),
    screenRecordingGranted: checkScreenRecordingPermission()
  })
  if (!summary) return null
  return {
    ok: false,
    summary,
    steps: [],
    handoffs: 0
  }
}

class VisionHost {
  async runTask(
    goal: string,
    taskId: string,
    journeyId = taskId,
    checkpoint?: TaskRetryCheckpoint
  ): Promise<VisionTaskResult> {
    const actuation = loadActuation()
    if (!actuation) {
      return {
        ok: false,
        summary: 'vision actuation is not available in this build',
        steps: [],
        handoffs: 0
      }
    }
    const blocked = permissionBlock()
    if (blocked) {
      return blocked
    }
    const guard = new VisionGuard()
    const request = new AbortController()
    const settings = getComputerUseSettings()
    const activeArtifacts = llm.activeModelArtifacts()
    if (!activeArtifacts) {
      return {
        ok: false,
        summary: 'Load a computer-use model before you start this task.',
        steps: [],
        handoffs: 0
      }
    }
    let modelAdapter: VisionModelAdapter
    try {
      // Same rule as Web Use: the user's strategy decides the adapter, not the model's name.
      modelAdapter = resolveVisionModelAdapterForStrategy(activeArtifacts, settings.modelStrategy)
    } catch (error) {
      return {
        ok: false,
        summary: error instanceof Error ? error.message : 'The computer-use model is not ready.',
        steps: [],
        handoffs: 0
      }
    }
    const modelIdentity = await resolveModelIdentity(activeArtifacts.id)
    const contextTokens = resolveComputerUseContextTokens(
      settings.context,
      llm.effectiveContextSize()
    )
    const retrievedFacts = [
      ...(checkpoint
        ? [
            `Resume checkpoint for task ${checkpoint.taskId}: ${checkpoint.steps.join('; ')}`,
            ...(checkpoint.currentAction
              ? [`Last attempted action: ${checkpoint.currentAction}`]
              : []),
            ...(checkpoint.summary ? [`Earlier attempt ended: ${checkpoint.summary}`] : [])
          ]
        : []),
      ...(settings.retrieveOlderVisuals ? recentVisualFacts(taskId) : [])
    ].slice(0, 5)
    // The kill switch: Esc halts the run and consumes the keypress. The supervisor's
    // Stop routes to the SAME guard via the controller session.
    const escapeRegistered = globalShortcut.register('Escape', () => {
      stopVisionTask(taskId, 'stopped with Esc', 'Stopped with Esc')
    })
    const releaseSession = registerVisionSession(taskId, guard, request)
    const coordinator = getTakeoverCoordinator()
    // Model-agnostic, but honest: warn (do not block) when the loaded model is
    // not a grounder, so the user sees why a click may miss and what to load.
    const notice = [
      visionModelNotice(llm.activeModelInfo()),
      escapeRegistered ? null : 'Esc is unavailable. Use Stop or Take Over in the task controls.'
    ]
      .filter((value): value is string => Boolean(value))
      .join(' ')
    emitVisionState({
      taskId,
      journeyId,
      ...modelIdentity,
      goal,
      status: 'running',
      phase: 'preparing',
      currentStep: 0,
      currentAction: 'Preparing local screen control',
      ...(notice ? { notice } : {})
    })
    showSupervisorWindow()
    const queuedGuidance: string[] = [...(checkpoint?.guidance ?? [])]
    const releaseGuidance = registerTaskGuideHandler(taskId, (text) => {
      queuedGuidance.push(text)
      return true
    })
    try {
      const plan =
        checkpoint?.plan ??
        (await prepareTaskExecutionPlan(
          {
            goal: retryPlanningGoal(goal, checkpoint),
            surface: 'computer',
            signal: request.signal
          },
          (marker) => emitVisionStep(taskId, marker)
        ))
      const result = await runVisionTaskGraph(goal, {
        screen: makeScreen({
          actuation,
          taskId,
          journeyId,
          goal,
          settings,
          screenshotResizeFactor: modelAdapter.screenshotResizeFactor
        }),
        guard,
        decide: createVisionGrounder(modelAdapter),
        parseResponse: modelAdapter.parseResponse,
        waitForUser: async (why) => {
          await coordinator.waitForTakeover(taskId, why)
        },
        onStep: (note) => emitVisionStep(taskId, note),
        plan,
        onPhase: (phaseId) => emitVisionStep(taskId, encodeTaskPhase(phaseId)),
        takeGuidance: () => queuedGuidance.splice(0),
        onProgress: (progress) => {
          emitVisionState({
            taskId,
            journeyId,
            goal,
            status:
              progress.phase === 'paused'
                ? 'paused'
                : progress.phase === 'stopped'
                  ? 'stopped'
                  : 'running',
            phase: progress.phase,
            currentStep: progress.step,
            currentAction: progress.action,
            ...(notice ? { notice } : {})
          })
        },
        contextTokens,
        checkpointInterval: settings.checkpointInterval,
        visualHistoryFrames: settings.visualHistoryFrames,
        retrievedFacts,
        signal: request.signal,
        onCheckpoint: () => {
          // Action-loop checkpoints do not include plan and phase markers.
          // Keep the canonical trace already stored by emitVisionStep.
          recordTaskRun({ taskId, kind: 'computer_use', title: goal })
        },
        onObservation: (observation) => {
          const geometry = observation.screenshot.metadata?.geometry
          appendComputerUseStepDetail(taskId, goal, {
            stepId: String(observation.step),
            at: Date.now(),
            phase: observation.phase,
            ...(geometry
              ? {
                  screenshot: {
                    path: observation.screenshot.metadata?.path,
                    availability: 'device_local',
                    executionDeviceId: getTaskExecutionDevice().id,
                    executionDeviceName: getTaskExecutionDevice().name,
                    originalWidth: geometry.sourceBounds.width,
                    originalHeight: geometry.sourceBounds.height,
                    inferenceWidth: geometry.encodedSize.width,
                    inferenceHeight: geometry.encodedSize.height
                  }
                }
              : {}),
            retrievedFacts: observation.retrievedFacts,
            decisionSummary: observation.decisionSummary,
            decisionRationale: observation.decisionRationale,
            rawResponse: observation.rawResponse,
            mappedAction:
              observation.failedActionIndex !== undefined
                ? JSON.stringify({
                    completed: observation.mappedActions ?? [],
                    failedActionIndex: observation.failedActionIndex,
                    failedAction: observation.parsedAction
                  })
                : observation.mappedActions?.length
                  ? JSON.stringify(observation.mappedActions)
                  : observation.mappedAction
                    ? JSON.stringify(observation.mappedAction)
                    : observation.parsedActions?.length
                      ? JSON.stringify(observation.parsedActions)
                      : observation.parsedAction
                        ? JSON.stringify(observation.parsedAction)
                        : undefined,
            execution: {
              status: observation.result === 'error' ? 'failed' : 'complete',
              durationMs: observation.durationMs,
              result: observation.result,
              error: observation.error
            }
          })
        }
      })
      emitVisionState({
        taskId,
        journeyId,
        goal,
        status: guard.isHalted ? 'stopped' : result.ok ? 'done' : 'failed',
        phase: guard.isHalted ? 'stopped' : result.ok ? 'complete' : 'failed',
        currentAction: result.summary,
        summary: result.summary
      })
      return result
    } catch (error) {
      const summary = guard.isHalted
        ? guard.snapshot().reason || 'Stopped'
        : error instanceof Error
          ? error.message
          : 'Computer Use failed.'
      emitVisionState({
        taskId,
        journeyId,
        goal,
        status: guard.isHalted ? 'stopped' : 'failed',
        phase: guard.isHalted ? 'stopped' : 'failed',
        currentAction: summary,
        summary
      })
      return { ok: false, summary, steps: [], handoffs: 0 }
    } finally {
      releaseGuidance()
      if (escapeRegistered) globalShortcut.unregister('Escape')
      releaseSession()
      hideSupervisorWindow()
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
