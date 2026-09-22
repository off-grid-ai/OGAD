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
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { screen, shell } from 'electron'
import { llm } from '../llm'
import type { VisionAction, Bounds } from './vision-action'
import {
  RecoverableVisionError,
  type VisionScreen,
  type VisionSemanticElement,
  type VisionTaskContinuation,
  type VisionTaskResult
} from './vision-agent'
import { VisionGuard } from './vision-guard'
import {
  controlVisionTask,
  emitVisionState,
  emitVisionStep,
  registerVisionSession,
  waitForVisionUser
} from './vision-controller'
import { hideSupervisorWindow, showSupervisorWindow } from './supervisor-window'
import { loadActuation, actuationAvailable, type ActuationPort } from '../input/actuation'
import { checkAccessibilityPermission, checkScreenRecordingPermission } from '../permissions'
import { mapActionToScreen, type DisplayGeometry } from '../input/coordinate-mapping'
import {
  appendComputerUseStepDetail,
  getTaskExecutionDevice,
  getTaskRun,
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
import { retryPlanningGoal, type TaskRetryCheckpoint } from '../tasks/task-retry'
import { dispatchVisionAction } from './vision-actuation'
import { encodeTaskPhase } from '../../shared/task-execution-plan'
import { prepareTaskExecutionPlan } from '../tasks/task-execution-plan-service'
import { automationTaskReadStatus } from '@offgrid/automation'
import { registerTaskGuideHandler } from '../tasks/task-guide'
import { withVisionTaskModelStrategy } from './vision-task-model-strategy'
import type { VisionTaskModelSession } from './vision-task-model-strategy'
import { computerUsePermissionBlock } from './computer-use-permissions'
import { runVisionTaskGraph } from './vision-task-graph'
import { captureComputerUseDisplay } from './computer-use-display-capture'
import { snapshotAccessibilityApp } from '../accessibility/ax-host'
import { accessibilityHelperPath } from '../accessibility/ax-helper'
import { recordComputerUseMetric } from '../actions/remote-screen-session'

const execFileAsync = promisify(execFile)
const MAX_MODEL_SEMANTIC_ELEMENTS = 40
const MAX_MODEL_INTERACTIVE_ELEMENTS = 28

function semanticElementKey(element: VisionSemanticElement): string {
  return [
    element.role,
    element.name,
    element.value,
    Math.round(element.point.x / 4),
    Math.round(element.point.y / 4)
  ].join('\n')
}

async function activateDefaultBrowser(): Promise<string | null> {
  const helper = accessibilityHelperPath()
  if (!helper) return null
  try {
    const { stdout } = await execFileAsync(helper, ['--default-browser'], { timeout: 4_000 })
    const browser = JSON.parse(stdout) as { name?: unknown; path?: unknown }
    if (
      typeof browser.name !== 'string' ||
      !browser.name.trim() ||
      typeof browser.path !== 'string' ||
      !browser.path.endsWith('.app')
    )
      return null
    await execFileAsync('/usr/bin/open', ['-a', browser.path], { timeout: 5_000 })
    return browser.name
  } catch {
    return null
  }
}

async function activateAndConfirmTarget(targetLabel: string): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  const helper = accessibilityHelperPath()
  if (!helper) return false
  try {
    await execFileAsync('/usr/bin/open', ['-a', targetLabel], { timeout: 5_000 })
    const { stdout } = await execFileAsync(helper, ['--frontmost-app'], { timeout: 2_000 })
    return stdout.trim().toLocaleLowerCase() === targetLabel.trim().toLocaleLowerCase()
  } catch {
    return false
  }
}

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
  targetLabel?: string
}): VisionScreen {
  const { actuation, taskId, journeyId, goal, settings, screenshotResizeFactor, targetLabel } =
    input
  // The display the last screenshot was taken from. Its scaleFactor + origin move
  // the grounder's DIP coordinates into the actuation space (physical px on
  // Windows). capture() always runs before actuate() in the vision loop.
  let capturedDisplay: DisplayGeometry | null = null
  let capturedGeometry: ScreenshotGeometry | null = null
  let capturedProcessId: number | undefined
  let capturedWindowId: string | undefined
  let capturedPlatformWindowId: number | undefined
  let captureNumber = 0
  return {
    async capture() {
      if (targetLabel && !(await activateAndConfirmTarget(targetLabel))) {
        throw new RecoverableVisionError(`The target app ${targetLabel} is not frontmost.`)
      }
      const semanticSnapshot = targetLabel ? await snapshotAccessibilityApp(targetLabel) : null
      capturedProcessId = semanticSnapshot?.processId
      capturedWindowId = semanticSnapshot?.windowId
      capturedPlatformWindowId = semanticSnapshot?.platformWindowId
      const rawWindowBounds = semanticSnapshot?.windowBounds
      const windowBounds =
        rawWindowBounds && rawWindowBounds.width > 0 && rawWindowBounds.height > 0
          ? process.platform === 'win32'
            ? (() => {
                const origin = screen.screenToDipPoint({
                  x: rawWindowBounds.x,
                  y: rawWindowBounds.y
                })
                const edge = screen.screenToDipPoint({
                  x: rawWindowBounds.x + rawWindowBounds.width,
                  y: rawWindowBounds.y + rawWindowBounds.height
                })
                return {
                  x: origin.x,
                  y: origin.y,
                  width: Math.max(1, edge.x - origin.x),
                  height: Math.max(1, edge.y - origin.y)
                }
              })()
            : rawWindowBounds
          : null
      const targetPoint = windowBounds
        ? {
            x: Math.round(windowBounds.x + windowBounds.width / 2),
            y: Math.round(windowBounds.y + windowBounds.height / 2)
          }
        : screen.getCursorScreenPoint()
      const display = screen.getDisplayNearestPoint(targetPoint)
      const { width, height } = display.size
      // Native menus, pickers, sheets, and popovers are separate macOS windows.
      // An exact target-window capture drops them even though they can receive
      // the next click. Capture the target display so observation and actuation
      // use the same visible surface.
      const cropBounds = { x: 0, y: 0, width, height }
      const exposeSemanticElements =
        (settings.modelStrategy === 'text_plus_specialist' ||
          settings.modelStrategy === 'decision_plus_specialist') &&
        settings.enabledRails.includes('ax')
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
      // Retry the one native capture owner when the system is temporarily busy.
      let png: Buffer | null = null
      let encodedSize: { width: number; height: number } | null = null
      for (let attempt = 0; attempt < 4 && (png === null || png.length === 0); attempt += 1) {
        try {
          const captured = await captureComputerUseDisplay({
            displayId: Number(display.id),
            ...captureSize
          })
          const cropPixels = {
            left: Math.max(0, Math.round((cropBounds.x * captured.width) / width)),
            top: Math.max(0, Math.round((cropBounds.y * captured.height) / height)),
            width: Math.max(1, Math.round((cropBounds.width * captured.width) / width)),
            height: Math.max(1, Math.round((cropBounds.height * captured.height) / height))
          }
          cropPixels.width = Math.min(cropPixels.width, captured.width - cropPixels.left)
          cropPixels.height = Math.min(cropPixels.height, captured.height - cropPixels.top)
          const cropped =
            cropPixels.left === 0 &&
            cropPixels.top === 0 &&
            cropPixels.width === captured.width &&
            cropPixels.height === captured.height
              ? captured.png
              : await sharp(captured.png).extract(cropPixels).png().toBuffer()
          const sourceSize = { width: cropPixels.width, height: cropPixels.height }
          const plannedTarget = planAspectPreservingResize(
            sourceSize,
            SCREENSHOT_MAX_EDGE[settings.screenshotSize]
          ).encodedSize
          const target = screenshotResizeFactor
            ? alignPixelSize(plannedTarget, screenshotResizeFactor)
            : plannedTarget
          png =
            target.width === sourceSize.width && target.height === sourceSize.height
              ? cropped
              : await sharp(cropped)
                  .resize({
                    ...target,
                    kernel: SCREENSHOT_RESIZE_KERNEL.efficient
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
        sourceBounds: cropBounds,
        encodedSize,
        scale: Math.min(
          encodedSize.width / cropBounds.width,
          encodedSize.height / cropBounds.height
        )
      }
      const visibleSemanticElements = (semanticSnapshot?.elements ?? [])
        .filter((element) => element.enabled && (element.name || element.value))
        .flatMap((element) => {
          const globalPoint =
            process.platform === 'win32'
              ? screen.screenToDipPoint({ x: element.cx, y: element.cy })
              : { x: element.cx, y: element.cy }
          const localX = globalPoint.x - display.bounds.x - cropBounds.x
          const localY = globalPoint.y - display.bounds.y - cropBounds.y
          if (localX < 0 || localY < 0 || localX >= cropBounds.width || localY >= cropBounds.height)
            return []
          return [
            {
              semantic: {
                index: element.index,
                role: element.role,
                name: element.name,
                value: element.value,
                actionable:
                  element.actionable ||
                  /(?:button|link|textfield|textarea|combobox|checkbox|radio|menuitem)/i.test(
                    element.role
                  ),
                point: {
                  x: Math.min(
                    encodedSize.width - 1,
                    Math.round((localX * encodedSize.width) / cropBounds.width)
                  ),
                  y: Math.min(
                    encodedSize.height - 1,
                    Math.round((localY * encodedSize.height) / cropBounds.height)
                  )
                }
              } satisfies VisionSemanticElement,
              interactive:
                element.actionable ||
                /(?:button|link|textfield|textarea|combobox|checkbox|radio|menuitem)/i.test(
                  element.role
                )
            }
          ]
        })
      const seenSemanticElements = new Set<string>()
      const uniqueSemanticElements = visibleSemanticElements.filter(({ semantic }) => {
        const key = semanticElementKey(semantic)
        if (seenSemanticElements.has(key)) return false
        seenSemanticElements.add(key)
        return true
      })
      const allInteractiveSemanticElements = uniqueSemanticElements.filter(
        (element) => element.interactive
      )
      const interactiveSemanticElements = allInteractiveSemanticElements.slice(
        0,
        MAX_MODEL_INTERACTIVE_ELEMENTS
      )
      const informationalSemanticElements = uniqueSemanticElements.filter(
        (element) => !element.interactive
      )
      const semanticElements = [
        ...interactiveSemanticElements,
        ...informationalSemanticElements.slice(
          0,
          Math.max(0, MAX_MODEL_SEMANTIC_ELEMENTS - interactiveSemanticElements.length)
        )
      ].map((element) => element.semantic)
      const verificationSemanticElements = uniqueSemanticElements.map(
        (element) => element.semantic
      )
      if (uniqueSemanticElements.length > MAX_MODEL_SEMANTIC_ELEMENTS) {
        console.log(
          `[computer-task] accessibility raw=${semanticSnapshot?.elements.length ?? 0} visible=${visibleSemanticElements.length} unique=${uniqueSemanticElements.length} model=${semanticElements.length} verification=${verificationSemanticElements.length}`
        )
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
        metadata: {
          path: savedScreenshot,
          geometry: capturedGeometry,
          ...(semanticSnapshot?.windowTitle
            ? { windowTitle: semanticSnapshot.windowTitle }
            : {}),
          ...(verificationSemanticElements.length ? { verificationSemanticElements } : {}),
          ...(exposeSemanticElements && semanticElements.length ? { semanticElements } : {})
        }
      }
    },
    async actuate(action: VisionAction) {
      if (targetLabel) {
        if (!(await activateAndConfirmTarget(targetLabel))) {
          return { rejected: `The target app ${targetLabel} is not frontmost.` }
        }
        const fresh = await snapshotAccessibilityApp(targetLabel)
        if (
          !fresh ||
          fresh.processId !== capturedProcessId ||
          fresh.windowId !== capturedWindowId ||
          (process.platform === 'darwin' && fresh.platformWindowId !== capturedPlatformWindowId)
        ) {
          return { rejected: `The target window for ${targetLabel} changed after capture.` }
        }
      }
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
      const result = await dispatchVisionAction({
        actuation,
        action: mapped,
        goal,
        navigate: (url) => shell.openExternal(url)
      })
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
    checkpoint?: TaskRetryCheckpoint,
    continuation?: VisionTaskContinuation,
    targetLabel?: string,
    sessionLimitMs?: number
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
    const guard = continuation?.guard ?? new VisionGuard({ taskId, kind: 'computer_use' })
    const request = continuation?.request ?? new AbortController()
    const settings = getComputerUseSettings()
    const defaultBrowser =
      process.platform === 'darwin' && /default browser/i.test(goal)
        ? await activateDefaultBrowser()
        : null
    if (process.platform === 'darwin' && /default browser/i.test(goal) && !defaultBrowser) {
      return {
        ok: false,
        summary:
          'Computer Use could not identify and focus the macOS default browser. Check the default browser setting and retry.',
        steps: [],
        handoffs: 0
      }
    }
    const resolvedTargetLabel = targetLabel ?? defaultBrowser ?? undefined
    try {
      return await withVisionTaskModelStrategy(
        'desktop',
        async ({ adapter: modelAdapter, identity: modelIdentity, decide }) => {
          const contextTokens = resolveComputerUseContextTokens(
            settings.context,
            llm.effectiveContextSize()
          )
          const retrievedFacts = [
            ...(defaultBrowser
              ? [
                  `macOS default browser: ${defaultBrowser}. It is now frontmost; use this browser for the task.`
                ]
              : []),
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
          return this.runActiveTask({
            goal,
            taskId,
            journeyId,
            checkpoint,
            actuation,
            guard,
            request,
            settings,
            modelAdapter,
            modelIdentity,
            decide,
            contextTokens,
            retrievedFacts,
            continuation,
            targetLabel: resolvedTargetLabel,
            sessionLimitMs
          })
        },
        undefined,
        {
          specialistOnly: continuation?.specialistOnly,
          reasonerOnly: continuation?.reasonerOnly
        }
      )
    } catch (error) {
      return {
        ok: false,
        summary: error instanceof Error ? error.message : 'The computer-use model is not ready.',
        steps: [],
        handoffs: 0
      }
    }
  }

  private async runActiveTask(input: {
    goal: string
    taskId: string
    journeyId: string
    checkpoint?: TaskRetryCheckpoint
    actuation: ActuationPort
    guard: VisionGuard
    request: AbortController
    settings: ComputerUseSettings
    modelAdapter: import('./model-adapters/types').VisionModelAdapter
    modelIdentity: { modelId: string; modelName: string }
    decide: VisionTaskModelSession['decide']
    contextTokens: number
    retrievedFacts: string[]
    continuation?: VisionTaskContinuation
    targetLabel?: string
    sessionLimitMs?: number
  }): Promise<VisionTaskResult> {
    const {
      goal,
      taskId,
      journeyId,
      checkpoint,
      actuation,
      guard,
      request,
      settings,
      modelAdapter,
      modelIdentity,
      decide,
      contextTokens,
      retrievedFacts,
      continuation,
      targetLabel,
      sessionLimitMs
    } = input
    const ownsControls = !continuation
    const releaseSession = ownsControls
      ? registerVisionSession(taskId, guard, request, undefined, sessionLimitMs)
      : () => undefined
    if (ownsControls) showSupervisorWindow()
    emitVisionState({
      taskId,
      journeyId,
      ...modelIdentity,
      rail: 'vision',
      goal,
      status: 'running',
      phase: 'preparing',
      currentStep: 0,
      currentAction: 'Preparing local screen control'
    })
    const queuedGuidance = continuation?.queuedGuidance ?? [...(checkpoint?.guidance ?? [])]
    const releaseGuidance = ownsControls
      ? registerTaskGuideHandler(taskId, (text) => {
          queuedGuidance.push(text)
          controlVisionTask('resume', taskId)
          return true
        })
      : () => undefined
    try {
      const plan =
        checkpoint?.plan ??
        (await prepareTaskExecutionPlan(
          {
            goal: retryPlanningGoal(goal, checkpoint),
            surface: 'computer',
            targetLabel,
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
          screenshotResizeFactor: modelAdapter.screenshotResizeFactor,
          targetLabel
        }),
        guard,
        decide,
        parseResponse: modelAdapter.parseResponse,
        waitForUser: async (why, signal) => {
          await waitForVisionUser(taskId, why, signal)
        },
        onStep: (note) => emitVisionStep(taskId, note),
        plan,
        onPhase: (phaseId) => emitVisionStep(taskId, encodeTaskPhase(phaseId)),
        takeGuidance: () => queuedGuidance.splice(0),
        onModelIdentity: (identity) => {
          const current = getTaskRun(taskId)
          emitVisionState({
            taskId,
            journeyId,
            ...identity,
            rail: 'vision',
            goal,
            status: 'running',
            phase: current?.phase ?? 'thinking',
            currentStep: current?.currentStep ?? 0,
            currentAction: current?.currentAction ?? 'Selecting the next action'
          })
        },
        onProgress: (progress) => {
          emitVisionState({
            taskId,
            journeyId,
            ...(continuation?.specialistOnly || continuation?.reasonerOnly ? modelIdentity : {}),
            goal,
            status:
              progress.phase === 'paused'
                ? 'paused'
                : progress.phase === 'stopped'
                  ? 'stopped'
                  : 'running',
            phase: progress.phase,
            currentStep: progress.step,
            currentAction: progress.action
          })
        },
        contextTokens,
        checkpointInterval: settings.checkpointInterval,
        visualHistoryFrames: settings.visualHistoryFrames,
        repeatUntilSessionLimit: Boolean(sessionLimitMs),
        returnAfterAction: continuation?.returnAfterAction,
        resumedSteps: checkpoint?.steps,
        retrievedFacts,
        signal: request.signal,
        onCheckpoint: () => {
          // Action-loop checkpoints do not include plan and phase markers.
          // Keep the canonical trace already stored by emitVisionStep.
          recordTaskRun({ taskId, kind: 'computer_use', title: goal })
        },
        onObservation: (observation) => {
          recordComputerUseMetric('visionSteps')
          if (observation.result === 'actuated') {
            recordComputerUseMetric(
              'actions',
              observation.mappedActions?.length ?? observation.parsedActions?.length ?? 1
            )
          }
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
      if (continuation?.returnAfterAction && result.ok) {
        emitVisionState({
          taskId,
          journeyId,
          goal,
          status: 'running',
          phase: 'checking',
          currentAction: result.summary
        })
        return result
      }
      const finalStatus = automationTaskReadStatus(guard.automationStatus)
      emitVisionState({
        taskId,
        journeyId,
        goal,
        status: finalStatus,
        phase:
          finalStatus === 'done' ? 'complete' : finalStatus === 'failed' ? 'failed' : 'stopped',
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
      if (!guard.isHalted) guard.fail(summary)
      const finalStatus = automationTaskReadStatus(guard.automationStatus)
      emitVisionState({
        taskId,
        journeyId,
        goal,
        status: finalStatus,
        phase:
          finalStatus === 'done' ? 'complete' : finalStatus === 'failed' ? 'failed' : 'stopped',
        currentAction: summary,
        summary
      })
      return finalStatus === 'done'
        ? { ok: true, summary, steps: [], handoffs: 0 }
        : { ok: false, summary, steps: [], handoffs: 0 }
    } finally {
      releaseGuidance()
      releaseSession()
      if (ownsControls) {
        hideSupervisorWindow()
      }
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
