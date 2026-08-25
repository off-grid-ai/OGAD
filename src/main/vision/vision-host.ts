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
import { emitVisionState, emitVisionStep, registerVisionSession } from './vision-controller'
import { showSupervisorWindow, hideSupervisorWindow } from './supervisor-window'
import { visionModelNotice } from './vision-model-notice'
import { getTakeoverCoordinator } from '../browser/takeover'
import { loadActuation, actuationAvailable, type ActuationPort } from '../input/actuation'
import { mapActionToScreen, type DisplayGeometry } from '../input/coordinate-mapping'
import {
  appendComputerUseStepDetail,
  recordTaskRun,
  taskScreenshotPath
} from '../tasks/task-history'
import { getComputerUseSettings } from '../computer-use-settings'
import {
  resolveComputerUseContextTokens,
  SCREENSHOT_MAX_EDGE,
  SCREENSHOT_RESIZE_QUALITY,
  type ComputerUseSettings
} from '../../shared/computer-use-settings'
import {
  alignPixelSize,
  planAspectPreservingResize,
  type ScreenshotGeometry
} from './screenshot-geometry'
import { recentVisualFacts } from './visual-context'
import { resolveVisionModelAdapter } from './model-adapters'
import type { VisionModelAdapter, VisionPolicyRequest } from './model-adapters/types'
import { serializeVisionPolicyMessages } from './model-adapters/model-input'
import { imageMime } from '../llm/chat-payload'

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

async function runPolicyRequest(request: VisionPolicyRequest): Promise<string> {
  let lastError: unknown
  for (let attempt = 1; attempt <= request.maxAttempts; attempt += 1) {
    try {
      return await llm.chatMessages(request.messages, request.timeoutMs, request.maxTokens, {
        temperature: request.temperature,
        topP: request.topP,
        disableThinking: request.disableThinking
      })
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Computer-use model request failed.')
}

function makeScreen(input: {
  actuation: ActuationPort
  taskId: string
  goal: string
  settings: ComputerUseSettings
  screenshotResizeFactor?: number
}): VisionScreen {
  const { actuation, taskId, goal, settings, screenshotResizeFactor } = input
  // The display the last screenshot was taken from. Its scaleFactor + origin move
  // the grounder's DIP coordinates into the actuation space (physical px on
  // Windows). capture() always runs before actuate() in the vision loop.
  let capturedDisplay: DisplayGeometry | null = null
  let capturedGeometry: ScreenshotGeometry | null = null
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
      // desktopCapturer can hand back an EMPTY thumbnail when the system is busy
      // (e.g. right after a multi-GB model swap) - which becomes a 0-byte PNG and
      // then a llama-server "400 Failed to load image". Retry, prefer the source
      // for the cursor's display, and validate the buffer before writing.
      let png: Buffer | null = null
      let encodedSize: { width: number; height: number } | null = null
      for (let attempt = 0; attempt < 4 && (png === null || png.length === 0); attempt += 1) {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: captureSize
        })
        const source =
          sources.find((s) => String(s.display_id) === String(display.id)) ?? sources[0]
        if (source && !source.thumbnail.isEmpty()) {
          const sourceSize = source.thumbnail.getSize()
          const plannedTarget = planAspectPreservingResize(
            sourceSize,
            SCREENSHOT_MAX_EDGE[settings.screenshotSize]
          ).encodedSize
          const target = screenshotResizeFactor
            ? alignPixelSize(plannedTarget, screenshotResizeFactor)
            : plannedTarget
          const thumbnail =
            target.width === sourceSize.width && target.height === sourceSize.height
              ? source.thumbnail
              : source.thumbnail.resize({
                  ...target,
                  quality: SCREENSHOT_RESIZE_QUALITY[settings.screenshotQuality]
                })
          encodedSize = thumbnail.getSize()
          png = thumbnail.toPNG()
        }
        if (png === null || png.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      }
      if (png === null || png.length === 0) {
        throw new Error(
          'screen capture returned an empty image - check Screen Recording permission for Off Grid'
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
      fs.writeFileSync(CAPTURE_FILE, png)
      const savedScreenshot = taskScreenshotPath(taskId)
      fs.writeFileSync(savedScreenshot, png)
      recordTaskRun({
        taskId,
        kind: 'computer_use',
        title: goal,
        screenshotPath: savedScreenshot
      })
      // Return the file path - the grounder reads it from disk.
      return {
        image: CAPTURE_FILE,
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
      await dispatch(actuation, mapped)
      return { mappedAction: mapped }
    }
  }
}

async function dispatch(actuation: ActuationPort, action: VisionAction): Promise<void> {
  switch (action.type) {
    case 'click':
      await actuation.moveMouse(action.point.x, action.point.y)
      await actuation.click('left', 1)
      return
    case 'double_click':
      await actuation.moveMouse(action.point.x, action.point.y)
      await actuation.click('left', 2)
      return
    case 'right_click':
      await actuation.moveMouse(action.point.x, action.point.y)
      await actuation.click('right', 1)
      return
    case 'middle_click':
      await actuation.moveMouse(action.point.x, action.point.y)
      await actuation.click('middle', 1)
      return
    case 'triple_click':
      await actuation.moveMouse(action.point.x, action.point.y)
      await actuation.click('left', 3)
      return
    case 'drag':
      await actuation.moveMouse(action.from.x, action.from.y)
      await actuation.dragTo(action.to.x, action.to.y)
      return
    case 'drag_to':
      await actuation.dragTo(action.to.x, action.to.y)
      return
    case 'mouse_move':
      await actuation.moveMouse(action.point.x, action.point.y)
      return
    case 'type':
      await actuation.typeText(action.content)
      return
    case 'hotkey':
      await actuation.tapKeys(action.keys)
      return
    case 'press':
      await actuation.pressKeys(action.keys)
      return
    case 'key_down':
      await actuation.keyDown(action.keys)
      return
    case 'key_up':
      await actuation.keyUp(action.keys)
      return
    case 'scroll':
      await actuation.moveMouse(action.point.x, action.point.y)
      await actuation.scroll(action.direction)
      return
    case 'scroll_by':
      await actuation.scrollBy(action.axis, action.amount)
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
      modelAdapter = resolveVisionModelAdapter(activeArtifacts)
    } catch (error) {
      return {
        ok: false,
        summary: error instanceof Error ? error.message : 'The computer-use model is not ready.',
        steps: [],
        handoffs: 0
      }
    }
    const contextTokens = resolveComputerUseContextTokens(
      settings.context,
      llm.effectiveContextSize()
    )
    const retrievedFacts = settings.retrieveOlderVisuals ? recentVisualFacts(taskId) : []
    // The kill switch: Esc halts the run and consumes the keypress. The overlay's
    // Stop routes to the SAME guard via the controller session.
    globalShortcut.register('Escape', () => guard.halt('stopped with Esc'))
    const releaseSession = registerVisionSession(guard)
    const coordinator = getTakeoverCoordinator()
    // Model-agnostic, but honest: warn (do not block) when the loaded model is
    // not a grounder, so the user sees why a click may miss and what to load.
    const notice = visionModelNotice(llm.activeModelInfo())
    emitVisionState({ taskId, goal, status: 'running', ...(notice ? { notice } : {}) })
    showSupervisorWindow()
    try {
      const result = await runVisionTask(goal, {
        screen: makeScreen({
          actuation,
          taskId,
          goal,
          settings,
          screenshotResizeFactor: modelAdapter.screenshotResizeFactor
        }),
        guard,
        ground: ({ goal: currentGoal, image, history, retrievedFacts: facts, policyHistory }) => {
          const request = modelAdapter.buildRequest({
            goal: currentGoal,
            currentScreenshotDataUrl: `data:${imageMime(image)};base64,${fs.readFileSync(image).toString('base64')}`,
            history: policyHistory,
            recentSteps: history,
            olderVisualFacts: facts
          })
          return runPolicyRequest(request).then((response) => ({
            response,
            modelInput: serializeVisionPolicyMessages(request.messages)
          }))
        },
        parseResponse: modelAdapter.parseResponse,
        waitForUser: async (why) => {
          await coordinator.waitForTakeover(taskId, why)
        },
        onStep: (note) => emitVisionStep(taskId, note),
        contextTokens,
        checkpointInterval: settings.checkpointInterval,
        retrievedFacts,
        onCheckpoint: (_step, steps) => {
          recordTaskRun({ taskId, kind: 'computer_use', title: goal, steps: [...steps] })
        },
        onObservation: (observation) => {
          const geometry = observation.screenshot.metadata?.geometry
          appendComputerUseStepDetail(taskId, goal, {
            stepId: String(observation.step),
            at: Date.now(),
            modelInput: observation.promptContext,
            ...(geometry
              ? {
                  screenshot: {
                    path: observation.screenshot.metadata?.path,
                    originalWidth: geometry.sourceBounds.width,
                    originalHeight: geometry.sourceBounds.height,
                    inferenceWidth: geometry.encodedSize.width,
                    inferenceHeight: geometry.encodedSize.height
                  }
                }
              : {}),
            retrievedFacts: observation.retrievedFacts,
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
        goal,
        status: result.ok ? 'done' : 'failed',
        summary: result.summary
      })
      return result
    } finally {
      globalShortcut.unregister('Escape')
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
