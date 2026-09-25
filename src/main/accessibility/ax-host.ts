/**
 * The accessibility rail's live host (R5 T1d) - the Electron shell the tested
 * element loop plugs into. It resolves the target app, reads that app's
 * interactive elements through the shipped Swift helper (`text-extractor
 * --elements <app>`), and drives it with synthetic input - one step at a time,
 * the model picking elements by LABEL. A vision-capable chat model also gets
 * the captured frame that matches the AX list.
 *
 * This is the cheapest tier: the app publishes controls over Accessibility. A
 * display frame is recorded for supervision and is sent with the AX list when
 * the active chat model supports images. The router (ax-router) decides whether
 * the tree is rich enough; when it is not, the caller falls through to vision.
 *
 * Native/Electron glue over the tested spine (parser, router, loop, target
 * picker), so it is excluded from in-process coverage; it is exercised on a
 * real machine with the Accessibility grant.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { screen, systemPreferences } from 'electron'
import { automationTaskReadStatus, selectApplicationTarget } from '@offgrid/automation'
import { llm } from '../llm'
import { extractJsonObject } from '../json-extract'
import { loadActuation, type ActuationPort } from '../input/actuation'
import {
  formatAxElementsForModel,
  parseAxElements,
  type AxElement,
  type AxSnapshot
} from './ax-elements'
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
  controlVisionTask,
  emitVisionState,
  emitVisionStep,
  registerVisionSession,
  waitForVisionUser
} from '../vision/vision-controller'
import { hideSupervisorWindow, showSupervisorWindow } from '../vision/supervisor-window'
import { getComputerUseSettings } from '../computer-use-settings'
import { resolveComputerUseContextTokens } from '../../shared/computer-use-settings'
import { recentVisualFacts } from '../vision/visual-context'
import { getTaskRun, recordTaskRun } from '../tasks/task-history'
import { persistAxFrame, persistAxObservation, type AxObservationFrame } from './ax-observation'
import { captureAxObservationFrame } from './ax-frame'
import { accessibilityHelperPath } from './ax-helper'
import { encodeTaskPhase, taskExecutionPlanProgress } from '../../shared/task-execution-plan'
import { prepareTaskExecutionPlan } from '../tasks/task-execution-plan-service'
import { registerTaskGuideHandler } from '../tasks/task-guide'
import {
  resolveComputerUseModelArtifact,
  resolveModelIdentity,
  type ModelIdentity
} from '../models-manager'
import { NativeAppTargeter, type InstalledNativeApp } from './native-app-target'
import { createMacNativeAppPlatform, resolveMacDefaultBrowser } from './native-app-macos'
import { resolveWindowsDefaultBrowser, windowsNativeAppPlatform } from './native-app-windows'
import type { TaskRetryCheckpoint } from '../tasks/task-retry'
import type { VisionTaskContinuation } from '../vision/vision-agent'
import type { VisionExecuteResult } from '../vision/vision-rail'
import { submitsDraft } from '../vision/vision-action'
import {
  currentRemoteScreenTaskSession,
  recordComputerUseMetric,
  recordComputerUseModelCall
} from '../actions/remote-screen-session'
import { parseRemoteVisionModelId, remoteVisionModelId } from '../../shared/remote-vision-server'
import { chooseFactorizedElementStep } from './ax-decision'
import {
  decideWithDecisionModel,
  selectedDecisionModelId,
  withDecisionModel
} from './decision-model-loader'
import { listInstalled } from '../models-manager'
import { computerUsePreflight } from '../vision/computer-use-preflight'
import {
  compactWriterPrompt,
  parseWriterResult,
  writerInputIsPrivate,
  type WriterResult
} from './ax-writer'
import { verifyPostcondition, type VerificationObservation } from './ax-verification'
import {
  nextObservationRevision,
  type DeterministicPostcondition,
  type NormalizedCandidate,
  type ObservationRevisionState,
  type WindowBoundObservation
} from './ax-state'
import { fuseCandidates } from './ax-ranking'
import { runBoxedOCR } from '../ocr'
import { runWindowsOCR } from './windows-ocr'
import { decisionRuntime, DecisionRuntimeError } from './decision-runtime'
import { selectedGrounderModelId } from '../vision/grounder-loader'
import { getRemoteVisionServerForModel } from '../vision/remote-vision-server'
import { continuationFromTaskSteps } from '../vision/model-adapters/continuation-capsule'

const execFileAsync = promisify(execFile)

/** The product name, which must never be the target app (it is frontmost when
 *  the user approves the task). */
const SELF_APP_NAME = 'Off Grid AI Desktop'

const APP_TARGET_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'native_app_target',
    strict: true,
    schema: {
      type: 'object',
      properties: { targetApp: { type: 'string' } },
      required: ['targetApp'],
      additionalProperties: false
    }
  }
} as const

const WRITER_RESULT_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'computer_use_writer',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        fill: { type: 'boolean' },
        text: { type: 'string' },
        submit: { type: 'boolean' }
      },
      required: ['fill', 'text', 'submit'],
      additionalProperties: false
    }
  }
} as const

/** Thrown when Stop or Take Over halts a run mid-action so
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

/** Capture one app's current AX/UIA controls for the unified vision graph. */
export async function snapshotAccessibilityApp(app: string): Promise<AxSnapshot | null> {
  const backend = axBackend()
  return backend.available() ? backend.snapshot(app) : null
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

async function defaultBrowserTarget(): Promise<InstalledNativeApp | null> {
  if (process.platform === 'win32') return resolveWindowsDefaultBrowser()
  if (process.platform === 'darwin') {
    const helper = accessibilityHelperPath()
    return helper ? resolveMacDefaultBrowser(helper) : null
  }
  return null
}

async function inferInstalledAppTarget(goal: string): Promise<InstalledNativeApp | null> {
  const platform =
    process.platform === 'win32'
      ? windowsNativeAppPlatform
      : process.platform === 'darwin'
        ? (() => {
            const helper = accessibilityHelperPath()
            return helper ? createMacNativeAppPlatform(helper) : null
          })()
        : null
  if (!platform) return null
  const installed = await platform.listInstalled()
  const available = installed.filter(
    (app) =>
      selectApplicationTarget(SELF_APP_NAME, [
        {
          id: app.id,
          displayName: app.name,
          launchable: true,
          running: false,
          hasVisibleWindow: false
        }
      ]).outcome !== 'selected'
  )
  console.log(
    `[computer-task] native app inference inventory=${installed.length} available=${available.length}`
  )
  if (available.length === 0) return null
  const names = [...new Set(available.map((app) => app.name))].sort((a, b) => a.localeCompare(b))
  try {
    const raw = await llm.chat(
      [
        'Select the one installed native application that is best suited to complete the user goal.',
        'Use functional meaning when the user describes the app without naming it.',
        'Return an exact application name from the inventory. Return an empty string only when no listed app fits.',
        `User goal: ${goal}`,
        `Installed applications:\n${names.join('\n')}`
      ].join('\n'),
      [],
      undefined,
      undefined,
      { disableThinking: true, responseFormat: APP_TARGET_RESPONSE_FORMAT }
    )
    const json = extractJsonObject(raw)
    const targetApp = json ? (JSON.parse(json) as { targetApp?: unknown }).targetApp : null
    if (typeof targetApp !== 'string' || !targetApp.trim()) return null
    const candidates = available.map((app) => ({
      id: app.id,
      displayName: app.name,
      launchable: true,
      running: false,
      hasVisibleWindow: false
    }))
    const selection = selectApplicationTarget(targetApp, candidates)
    if (selection.outcome !== 'selected') return null
    const target = available.find((app) => app.id === selection.target.id) ?? null
    if (target) console.log(`[computer-task] inferred native app target="${target.name}"`)
    return target
  } catch (error) {
    console.warn('[computer-task] native app inference failed:', error)
    return null
  }
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

function verificationObservation(snapshot: AxSnapshot): VerificationObservation {
  const candidates: NormalizedCandidate[] = snapshot.elements.map((element, index) => ({
    id: element.stableId ?? `legacy:${snapshot.windowTitle}:${element.index}`,
    displayIndex: index + 1,
    source: element.source ?? 'ax',
    role: element.role,
    label: element.name,
    value: element.value,
    bounds: {
      x: element.x ?? element.cx,
      y: element.y ?? element.cy,
      width: element.width ?? 0,
      height: element.height ?? 0
    },
    center: { x: element.cx, y: element.cy },
    enabled: element.enabled,
    ...(typeof element.checked === 'boolean' ? { checked: element.checked } : {}),
    ...(typeof element.hasPopup === 'boolean' ? { hasPopup: element.hasPopup } : {}),
    snapshotId: `${snapshot.windowId ?? snapshot.windowTitle}:${snapshot.revision ?? 0}`,
    revision: snapshot.revision ?? 0,
    windowId: snapshot.windowId ?? snapshot.windowTitle,
    processId: snapshot.processId ?? 0,
    risk: element.risk ?? 'reversible'
  }))
  return {
    windowId: snapshot.windowId ?? snapshot.windowTitle,
    processId: snapshot.processId ?? 0,
    windowTitle: snapshot.windowTitle,
    candidates
  }
}

function makeElementActuator(
  actuation: ActuationPort,
  guard: VisionGuard,
  appName: string,
  onAction: (action: string) => void
): ElementActuator {
  const ensureLive = async (): Promise<AbortSignal> => {
    if (guard.isPaused) await guard.waitUntilRunnable()
    if (!guard.canActuate()) {
      throw new HaltError(guard.snapshot().reason || 'stopped')
    }
    guard.countStep()
    return guard.currentActionLease().signal
  }
  const clickCenter = async (el: AxElement, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted()
    await actuation.moveMouse(el.cx, el.cy)
    signal.throwIfAborted()
    await actuation.click('left', 1)
  }
  return {
    async click(el) {
      const signal = await ensureLive()
      onAction(`Click ${el.name || el.role}`)
      await clickCenter(el, signal)
    },
    async hover(el) {
      const signal = await ensureLive()
      onAction(`Open ${el.name || el.role}`)
      signal.throwIfAborted()
      await actuation.moveMouse(el.cx, el.cy)
    },
    async press(el) {
      // nut.js has no portable AXPress; a click at the element's center is the
      // reliable actuation and is what its coordinates are for.
      const signal = await ensureLive()
      onAction(`Press ${el.name || el.role}`)
      await clickCenter(el, signal)
    },
    async scroll(el, direction) {
      const signal = await ensureLive()
      onAction(`Scroll ${direction} in ${el.name || el.role}`)
      signal.throwIfAborted()
      await actuation.moveMouse(el.cx, el.cy)
      signal.throwIfAborted()
      if (direction === 'up' || direction === 'down') {
        await actuation.scrollBy('vertical', direction === 'up' ? 240 : -240)
      } else {
        await actuation.scrollBy('horizontal', direction === 'left' ? -240 : 240)
      }
    },
    async setValue(el, value) {
      const signal = await ensureLive()
      const helper = accessibilityHelperPath()
      if (!helper || process.platform !== 'darwin') {
        throw new Error('Native value control is unavailable.')
      }
      onAction(`Set ${el.name || el.role} to ${value}`)
      signal.throwIfAborted()
      await execFileAsync(
        helper,
        ['--set-slider-value', appName, String(el.cx), String(el.cy), String(value)],
        { timeout: 5_000, maxBuffer: 64 * 1024, signal }
      )
    },
    async type(el, text) {
      const signal = await ensureLive()
      onAction(el ? `Type in ${el.name || el.role}` : 'Type in the focused field')
      // With a target, focus it first; without one, type into the focused field.
      if (el) {
        await clickCenter(el, signal)
        if (el.value.trim()) {
          signal.throwIfAborted()
          await actuation.tapKeys(process.platform === 'darwin' ? 'command+a' : 'ctrl+a')
        }
      }
      signal.throwIfAborted()
      await actuation.typeText(text, signal)
    },
    async keys(combo) {
      const signal = await ensureLive()
      onAction(`Press ${combo}`)
      signal.throwIfAborted()
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
   * Null means no verified application target. An empty tree still preserves
   * the verified native target for visual control. */
  async routingSnapshot(goal: string): Promise<AxRouting | null> {
    const backend = axBackend()
    if (!backend.available()) {
      return null
    }
    const targeter = nativeAppTargeter()
    // Website tasks normally enter Web Use before this point. When Computer Use
    // receives one, it means the visible OS browser is required. Resolve that
    // browser directly so website words cannot falsely match another native app.
    const websiteGoal = namesWebsite(goal)
    let target = targeter
      ? websiteGoal
        ? await defaultBrowserTarget()
        : await targeter.resolve(goal)
      : null
    console.log(
      `[computer-task] native target lexical=${target?.name ?? 'none'} websiteGoal=${websiteGoal}`
    )
    if (!target && targeter && !websiteGoal) {
      target = await inferInstalledAppTarget(goal)
    }
    if (!target) {
      return null
    }
    const ready = await targeter!.ensureReady(target)
    if (!ready) return null
    const app = ready.runningName
    const snapshot = (await backend.snapshot(app)) ?? { windowTitle: app, elements: [] }
    return { app, snapshot }
  }

  /** Drive `app` toward `goal` over the accessibility rail. `initial` is the
   *  routing snapshot already taken, reused for the first step. */
  async runTask(
    goal: string,
    taskId: string,
    app: string,
    initial?: AxSnapshot,
    options: {
      journeyId?: string
      sessionLimitMs?: number
      checkpoint?: TaskRetryCheckpoint
      recoverWithVision?: (
        checkpoint: TaskRetryCheckpoint,
        continuation: VisionTaskContinuation
      ) => Promise<VisionExecuteResult>
    } = {}
  ): Promise<ElementTaskResult> {
    const journeyId = options.journeyId ?? taskId
    const { checkpoint, recoverWithVision } = options
    console.log(`[ax-rail] runTask app="${app}" goal="${goal}"`)
    const failBeforeStart = (summary: string): ElementTaskResult => {
      emitVisionState({
        taskId,
        journeyId,
        goal,
        status: 'failed',
        phase: 'failed',
        currentStep: 0,
        currentAction: summary,
        summary
      })
      return { ok: false, summary, steps: [] }
    }
    const actuation = loadActuation()
    const settings = getComputerUseSettings()
    const usesDecisionRuntime =
      settings.modelStrategy === 'decision_plus_specialist' ||
      settings.modelStrategy === 'decision_plus_reasoning'
    const requiresSpecialist = settings.modelStrategy === 'decision_plus_specialist'
    const installedModels = await listInstalled()
    const decisionModelId = selectedDecisionModelId()
    const specialistModelId = selectedGrounderModelId()
    const remoteDecision = getRemoteVisionServerForModel(decisionModelId, 'decision')
    const remoteSpecialist = getRemoteVisionServerForModel(specialistModelId, 'grounding')
    const specialistArtifact = remoteSpecialist
      ? null
      : await resolveComputerUseModelArtifact(specialistModelId)
    const admission = computerUsePreflight({
      accessibilityAvailable:
        process.platform !== 'darwin' || systemPreferences.isTrustedAccessibilityClient(true),
      capturePermission:
        process.platform !== 'darwin' ||
        systemPreferences.getMediaAccessStatus('screen') === 'granted',
      displayAvailable: screen.getAllDisplays().length > 0,
      targetWindowAvailable: Boolean(initial?.windowId || initial?.windowTitle),
      inputActuationAvailable: Boolean(actuation),
      decisionModelAvailable: Boolean(remoteDecision) || installedModels.includes(decisionModelId),
      decisionRuntimeAvailable: true,
      specialistRequired: requiresSpecialist,
      specialistAvailable:
        !requiresSpecialist || Boolean(remoteSpecialist) || Boolean(specialistArtifact),
      remoteCapabilityRequired: false,
      remoteCapabilityAvailable: true
    })
    if (!admission.ok) {
      console.log(`[ax-rail] BLOCKED: ${admission.failure}`)
      return failBeforeStart(admission.failure)
    }
    if (usesDecisionRuntime && !remoteDecision) {
      try {
        await decisionRuntime.start(decisionModelId)
      } catch (error) {
        if (error instanceof DecisionRuntimeError && error.code === 'out_of_memory') {
          console.warn(
            '[computer-use] Decision admission detected memory pressure; the explicit swap fallback will be used.'
          )
        } else {
          return failBeforeStart('decision_runtime_failed')
        }
      }
    }
    if (!actuation) {
      console.log('[ax-rail] BLOCKED: nut.js actuation not available in this build')
      return failBeforeStart('input actuation is not available in this build')
    }
    if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(true)) {
      console.log('[ax-rail] BLOCKED: Accessibility grant missing for Off Grid AI')
      return failBeforeStart(
        'Off Grid AI needs Accessibility access to control the screen. Grant it in System Settings > Privacy & Security > Accessibility, then run this again.'
      )
    }
    const guard = new VisionGuard({ taskId, kind: 'computer_use' })
    const request = new AbortController()
    const remoteModel = currentRemoteScreenTaskSession()?.activeServer
    const activeModel = llm.activeModelInfo()
    const reasonerModelId = remoteModel
      ? remoteVisionModelId(remoteModel.id, remoteModel.model)
      : activeModel?.id
    const [decisionIdentity, reasonerIdentity, specialistIdentity] = await Promise.all([
      usesDecisionRuntime ? resolveModelIdentity(decisionModelId) : Promise.resolve(undefined),
      reasonerModelId ? resolveModelIdentity(reasonerModelId) : Promise.resolve(undefined),
      requiresSpecialist ? resolveModelIdentity(specialistModelId) : Promise.resolve(undefined)
    ])
    let axStateIdentity = {
      ...(decisionIdentity ?? reasonerIdentity),
      rail: 'accessibility' as const
    }
    const useStateIdentity = (identity: ModelIdentity | undefined): void => {
      axStateIdentity = { ...identity, rail: 'accessibility' as const }
    }
    const contextTokens = resolveComputerUseContextTokens(
      settings.context,
      llm.effectiveContextSize()
    )
    const retrievedFacts = settings.retrieveOlderVisuals ? recentVisualFacts(taskId) : []
    const sessionDeadline = options.sessionLimitMs ? Date.now() + options.sessionLimitMs : undefined
    const releaseSession = registerVisionSession(
      taskId,
      guard,
      request,
      undefined,
      options.sessionLimitMs
    )
    showSupervisorWindow()
    // The AX rail is model-agnostic and needs no grounding-model notice.
    emitVisionState({
      taskId,
      journeyId,
      ...axStateIdentity,
      goal,
      status: 'running',
      phase: 'preparing',
      currentStep: 0,
      currentAction: `Preparing to control ${app}`
    })
    let usedInitial = false
    let liveStep = checkpoint?.currentStep ?? 0
    let captureNumber = 0
    let observationFrame: AxObservationFrame | undefined
    let revisionState: ObservationRevisionState | undefined
    let currentCandidates: NormalizedCandidate[] = []
    const queuedGuidance: string[] = [...(checkpoint?.guidance ?? [])]
    const releaseGuidance = registerTaskGuideHandler(taskId, (text) => {
      queuedGuidance.push(text)
      controlVisionTask('resume', taskId)
      return true
    })
    const callReasoner = async (
      stage: string,
      modelRequest: unknown,
      task: () => Promise<string>
    ): Promise<string> => {
      const startedAt = Date.now()
      const session = currentRemoteScreenTaskSession()
      const model = session?.activeServer ? undefined : llm.activeModelInfo()?.id
      recordComputerUseMetric('reasoningCalls')
      try {
        const response = await task()
        await recordComputerUseModelCall({
          role: 'reasoning',
          stage,
          rail: 'ax',
          ...(model ? { model } : {}),
          request: modelRequest,
          response,
          startedAt
        })
        return response
      } catch (error) {
        await recordComputerUseModelCall({
          role: 'reasoning',
          stage,
          rail: 'ax',
          ...(model ? { model } : {}),
          request: modelRequest,
          error,
          startedAt
        })
        throw error
      }
    }
    try {
      const plan =
        checkpoint?.plan ??
        (await prepareTaskExecutionPlan(
          {
            goal,
            surface: 'computer',
            targetLabel: app,
            ...(initial ? { currentState: formatAxElementsForModel(initial, 80) } : {}),
            signal: request.signal
          },
          (marker) => emitVisionStep(taskId, marker)
        ))
      const runLoop = (): Promise<ElementTaskResult> =>
        runElementTask(goal, {
          read: async () => {
            emitVisionState({
              taskId,
              journeyId,
              ...axStateIdentity,
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
            const windowBounds = snapshot.windowBounds ?? observationFrame.capture.displayBounds
            snapshot.windowBounds = windowBounds
            snapshot.windowId =
              snapshot.windowId ?? `${snapshot.processId ?? 0}:${snapshot.windowTitle}`
            const window = {
              platform: process.platform,
              processId: snapshot.processId ?? 0,
              processName: snapshot.processName ?? app,
              windowId: snapshot.windowId,
              windowTitle: snapshot.windowTitle,
              bounds: windowBounds
            }
            // AX describes the target process, but another process can still put a
            // system dialog above its window. Always fuse visible text so the
            // decision layer can see screen-level blockers instead of acting on
            // controls that are present in AX but physically occluded.
            const ocr =
              process.platform === 'win32'
                ? await runWindowsOCR(observationFrame.capture.path)
                : await runBoxedOCR(observationFrame.capture.path)
            const scaleX = windowBounds.width / (ocr.width || observationFrame.capture.width)
            const scaleY = windowBounds.height / (ocr.height || observationFrame.capture.height)
            const ocrBlocks = ocr.blocks.map((block) => ({
              ...block,
              bounds: {
                x: windowBounds.x + block.bounds.x * scaleX,
                y: windowBounds.y + block.bounds.y * scaleY,
                width: block.bounds.width * scaleX,
                height: block.bounds.height * scaleY
              }
            }))
            snapshot.visibleText = ocrBlocks
              .map((block) => block.text.trim())
              .filter(Boolean)
              .join(' ')
            const facts = [
              ...snapshot.elements.map(
                (element) =>
                  `ax:${element.role}:${element.name}:${element.value}:${element.x ?? element.cx}:${element.y ?? element.cy}:focused=${element.focused === true}:checked=${String(element.checked ?? 'unknown')}:selected=${String(element.selected ?? 'unknown')}:hasPopup=${element.hasPopup === true}:enabled=${element.enabled}`
              ),
              ...ocrBlocks.map(
                (block) =>
                  `ocr:${block.text}:${Math.round(block.bounds.x)}:${Math.round(block.bounds.y)}:${Math.round(block.bounds.width)}:${Math.round(block.bounds.height)}`
              )
            ]
            revisionState = nextObservationRevision(revisionState, window, facts)
            snapshot.revision = revisionState.revision
            const observation: WindowBoundObservation = {
              snapshotId: `${snapshot.windowId}:${revisionState.revision}:${captureNumber}`,
              revision: revisionState.revision,
              window,
              capture: {
                sourceBounds: windowBounds,
                encodedWidth: observationFrame.capture.width,
                encodedHeight: observationFrame.capture.height,
                scaleX,
                scaleY
              },
              sources: {
                ax: { available: process.platform === 'darwin' },
                uia: { available: process.platform === 'win32' },
                ocr: {
                  available: ocr.available,
                  ...(ocr.degradedReason ? { degradedReason: ocr.degradedReason } : {})
                },
                capture: { available: true }
              }
            }
            const originalById = new Map(
              snapshot.elements
                .filter((element) => element.stableId)
                .map((element) => [element.stableId!, element])
            )
            const fused = fuseCandidates({
              observation,
              elements: snapshot.elements,
              ocr: ocrBlocks,
              allowOcrClicks: false
            })
            currentCandidates = fused
            snapshot.elements = fused.map((candidate) => {
              const original = originalById.get(candidate.id)
              return {
                index: candidate.displayIndex,
                role: candidate.role,
                name: candidate.label,
                value: candidate.value,
                x: candidate.bounds.x,
                y: candidate.bounds.y,
                width: candidate.bounds.width,
                height: candidate.bounds.height,
                cx: candidate.center.x,
                cy: candidate.center.y,
                stableId: candidate.id,
                source: candidate.source,
                processId: candidate.processId,
                windowId: candidate.windowId,
                revision: candidate.revision,
                region: candidate.region,
                ...(typeof candidate.checked === 'boolean' ? { checked: candidate.checked } : {}),
                ...(typeof candidate.selected === 'boolean'
                  ? { selected: candidate.selected }
                  : {}),
                ...(typeof candidate.hasPopup === 'boolean'
                  ? { hasPopup: candidate.hasPopup }
                  : {}),
                ...(typeof original?.focused === 'boolean' ? { focused: original.focused } : {}),
                ...(typeof original?.minValue === 'number' ? { minValue: original.minValue } : {}),
                ...(typeof original?.maxValue === 'number' ? { maxValue: original.maxValue } : {}),
                ...(typeof original?.valueSettable === 'boolean'
                  ? { valueSettable: original.valueSettable }
                  : {}),
                risk: candidate.risk,
                actionable:
                  candidate.executable?.type === 'activate' &&
                  candidate.executable.method === 'press',
                enabled: candidate.enabled,
                executable: candidate.executable !== undefined
              }
            })
            // The next model/progress update prunes unreferenced task images.
            // Reference this frame first so the live view can load it while the
            // model decides and after the task completes.
            persistAxFrame({ taskId, journeyId, title: goal, frame: observationFrame })
            return snapshot
          },
          actuator: makeElementActuator(actuation, guard, app, (action) => {
            emitVisionState({
              taskId,
              journeyId,
              ...axStateIdentity,
              goal,
              status: 'running',
              phase: 'acting',
              currentStep: liveStep,
              currentAction: action
            })
          }),
          screenshotPath: () =>
            remoteModel || activeModel?.vision ? observationFrame?.capture.path : undefined,
          decide: async (prompt, screenshotPath) => {
            liveStep += 1
            console.log(`[ax-rail] decision input: image=${Boolean(screenshotPath)}`)
            useStateIdentity(reasonerIdentity)
            emitVisionState({
              taskId,
              journeyId,
              ...axStateIdentity,
              goal,
              status: 'running',
              phase: 'thinking',
              currentStep: liveStep,
              currentAction: 'Choosing the next action'
            })
            const images = screenshotPath ? [screenshotPath] : []
            const response = await callReasoner('ax_step_decision', { prompt, images }, () =>
              llm.chat(prompt, images, undefined, undefined, {
                responseFormat: ELEMENT_STEP_FORMAT,
                enableThinking: true,
                separateReasoning: true,
                signal: request.signal
              })
            )
            const raw = response.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '').trim()
            console.log(`[ax-rail] model reply: ${JSON.stringify(raw.slice(0, 400))}`)
            return raw
          },
          ...(settings.modelStrategy === 'decision_plus_specialist' ||
          settings.modelStrategy === 'decision_plus_reasoning'
            ? {
                decideElement: async (
                  prompt: string,
                  snapshot: AxSnapshot,
                  phase,
                  allowCompletion,
                  pendingSubmit
                ) => {
                  liveStep += 1
                  useStateIdentity(decisionIdentity)
                  emitVisionState({
                    taskId,
                    journeyId,
                    ...axStateIdentity,
                    goal,
                    status: 'running',
                    phase: 'thinking',
                    currentStep: liveStep,
                    currentAction: 'Scoring the next action'
                  })
                  const actionMemory = continuationFromTaskSteps(
                    getTaskRun(taskId)?.steps ?? [],
                    settings.visualHistoryFrames,
                    phase?.title ?? 'Choose the next safe action'
                  )
                  const deciderPrompt = actionMemory
                    ? `${prompt}\nBounded semantic action memory: ${JSON.stringify(actionMemory)}`
                    : prompt
                  let decision
                  try {
                    decision = await chooseFactorizedElementStep(
                      deciderPrompt,
                      snapshot,
                      (context, question, options) =>
                        decideWithDecisionModel(context, question, options, request.signal),
                      phase,
                      allowCompletion,
                      Date.now,
                      new Set(),
                      pendingSubmit
                    )
                  } catch (error) {
                    if (request.signal.aborted) throw error
                    const message = error instanceof Error ? error.message : String(error)
                    console.warn(
                      `[ax-rail] decider unavailable; requesting visual recovery: ${message}`
                    )
                    useStateIdentity(specialistIdentity)
                    emitVisionState({
                      taskId,
                      journeyId,
                      ...axStateIdentity,
                      goal,
                      status: 'running',
                      phase: 'thinking',
                      currentStep: liveStep,
                      currentAction: 'Decision model unavailable; switching to visual grounding'
                    })
                    return JSON.stringify({
                      action: 'vision_required',
                      why: `The Decision model was unavailable: ${message}`
                    })
                  }
                  let step = decision.step
                  if (
                    step.action === 'vision_required' &&
                    step.why === 'A bounded free-text writer is required.'
                  ) {
                    const field = snapshot.elements.find(
                      (element) =>
                        element.index === decision.writerTargetIndex &&
                        element.enabled &&
                        element.executable !== false &&
                        /TextField|TextArea|Edit|Document|ComboBox/i.test(element.role)
                    )
                    if (field) {
                      const currentMilestone =
                        prompt
                          .split('\n')
                          .find((line) => line.startsWith('Current milestone: '))
                          ?.slice('Current milestone: '.length) ?? goal.slice(0, 1_600)
                      const writerInput = {
                        milestone: currentMilestone,
                        field: {
                          role: field.role,
                          label: field.name,
                          value: field.value,
                          secure:
                            field.role === 'AXSecureTextField' ||
                            field.risk === 'private' ||
                            field.risk === 'authentication' ||
                            field.risk === 'payment'
                        },
                        nearbyText: snapshot.elements
                          .filter((element) => Math.abs(element.cy - field.cy) < 180)
                          .map((element) => element.name || element.value)
                          .filter(Boolean),
                        recentActionResult: snapshot.windowTitle,
                        guidance: queuedGuidance
                      }
                      const plannedText =
                        phase?.operation?.kind === 'clear' ? '' : phase?.operation?.value
                      const writer: WriterResult =
                        plannedText !== undefined
                          ? writerInputIsPrivate(writerInput)
                            ? {
                                fill: false,
                                text: '',
                                submit: false,
                                refusalReason: 'private_field'
                              }
                            : {
                                fill: true,
                                text: plannedText,
                                submit: phase?.operation?.kind === 'navigate'
                              }
                          : await (async () => {
                              useStateIdentity(reasonerIdentity)
                              emitVisionState({
                                taskId,
                                journeyId,
                                ...axStateIdentity,
                                goal,
                                status: 'running',
                                phase: 'thinking',
                                currentStep: liveStep,
                                currentAction: 'Writing text for the selected field'
                              })
                              const writerPrompt = compactWriterPrompt(writerInput)
                              const raw = await callReasoner(
                                'ax_text_writer',
                                { prompt: writerPrompt, images: [] },
                                () =>
                                  llm.chat(writerPrompt, [], undefined, undefined, {
                                    responseFormat: WRITER_RESULT_FORMAT,
                                    temperature: 0,
                                    disableThinking: true,
                                    signal: request.signal
                                  })
                              )
                              return parseWriterResult(raw, writerInput)
                            })()
                      step = writer.fill
                        ? {
                            action: 'type',
                            index: field.index,
                            text: writer.text,
                            ...(writer.submit ? { submitKeys: 'Enter' } : {})
                          }
                        : writer.refusalReason === 'private_field'
                          ? {
                              action: 'human_required',
                              why: 'The field needs private input.'
                            }
                          : {
                              action: 'give_up',
                              why: 'The public-text writer did not produce text.'
                            }
                    }
                  }
                  console.log(
                    `[ax-rail] decision confidence=${decision.result.combinedConfidence.toFixed(3)} margin=${decision.result.probabilityMargin.toFixed(3)} entropy=${decision.result.entropy.toFixed(3)} action=${step.action}`
                  )
                  return JSON.stringify({
                    ...step,
                    decisionEvidence: decision.result
                  })
                }
              }
            : {}),
          onStep: (note) => {
            console.log(`[ax-rail] step: ${note}`)
            emitVisionStep(taskId, note)
            emitVisionState({
              taskId,
              journeyId,
              ...axStateIdentity,
              goal,
              status: 'running',
              phase: 'checking',
              currentStep: liveStep,
              currentAction: note
            })
          },
          plan,
          resumedSteps: checkpoint?.steps,
          initialStep: checkpoint?.currentStep,
          ...(sessionDeadline ? { completionAllowed: () => Date.now() >= sessionDeadline } : {}),
          onPhase: (phaseId) => emitVisionStep(taskId, encodeTaskPhase(phaseId)),
          takeGuidance: () => queuedGuidance.splice(0),
          waitForUser: (why, signal) => waitForVisionUser(taskId, why, signal),
          validateAction: async (snapshot, action) => {
            const fresh = await axBackend().snapshot(app)
            if (!fresh) return false
            if (
              snapshot.windowId &&
              (fresh.windowId !== snapshot.windowId || fresh.processId !== snapshot.processId)
            ) {
              return false
            }
            if (!('index' in action) || action.index === undefined) return true
            const selected = snapshot.elements.find((element) => element.index === action.index)
            if (selected?.source === 'ocr') return false
            return Boolean(
              selected &&
              fresh.elements.some((element) =>
                selected.stableId
                  ? element.stableId === selected.stableId
                  : element.role === selected.role &&
                    element.name === selected.name &&
                    element.cx === selected.cx &&
                    element.cy === selected.cy
              )
            )
          },
          verifyAction: async (snapshot, action) => {
            const target =
              'index' in action && action.index !== undefined
                ? snapshot.elements.find((element) => element.index === action.index)
                : undefined
            const expected: DeterministicPostcondition =
              action.action === 'type' && target
                ? {
                    type: 'field_value',
                    candidateId:
                      target.stableId ?? `legacy:${snapshot.windowTitle}:${target.index}`,
                    value: action.text
                  }
                : action.action === 'set_value' && target
                  ? {
                      type: 'field_value',
                      candidateId:
                        target.stableId ?? `legacy:${snapshot.windowTitle}:${target.index}`,
                      value: String(action.value)
                    }
                  : target?.stableId
                    ? (currentCandidates.find((candidate) => candidate.id === target.stableId)
                        ?.expected ?? {
                        type: 'candidate_effect',
                        candidateId: target.stableId,
                        before: {
                          value: target.value,
                          enabled: target.enabled,
                          ...(typeof target.checked === 'boolean'
                            ? { checked: target.checked }
                            : {}),
                          ...(typeof target.selected === 'boolean'
                            ? { selected: target.selected }
                            : {})
                        }
                      })
                    : {
                        type: 'unverifiable',
                        reason: 'The action has no stable structured target.'
                      }
            const verification = await verifyPostcondition(
              expected,
              verificationObservation(snapshot),
              async () => {
                const fresh = await axBackend().snapshot(app)
                return fresh
                  ? verificationObservation(fresh)
                  : { ...verificationObservation(snapshot), processId: -1 }
              },
              {
                timeoutMs: 5_000,
                pollIntervalMs: 75,
                stableSamples: action.action === 'type' ? 1 : 2
              }
            )
            return verification
          },
          ...(recoverWithVision
            ? {
                recoverWithVision: async (recovery: {
                  summary: string
                  steps: readonly string[]
                  guidance: readonly string[]
                  currentStep: number
                }) => {
                  useStateIdentity(specialistIdentity)
                  emitVisionStep(
                    taskId,
                    'Accessibility control stalled. Switching to vision for one recovery action.'
                  )
                  emitVisionState({
                    taskId,
                    journeyId,
                    ...axStateIdentity,
                    goal,
                    status: 'running',
                    phase: 'observing',
                    currentStep: recovery.currentStep,
                    currentAction: 'Capturing the current screen for vision grounding'
                  })
                  if (recovery.guidance.length) queuedGuidance.unshift(...recovery.guidance)
                  const task = getTaskRun(taskId)
                  let result = await recoverWithVision(
                    {
                      taskId,
                      steps: task?.steps ?? [...recovery.steps],
                      ...(task?.stepDetails?.length ? { stepDetails: task.stepDetails } : {}),
                      plan,
                      ...(recovery.guidance.length ? { guidance: [...recovery.guidance] } : {}),
                      summary: recovery.summary,
                      currentStep: recovery.currentStep,
                      currentAction: recovery.summary
                    },
                    {
                      guard,
                      request,
                      queuedGuidance,
                      returnAfterAction: true,
                      specialistOnly: true
                    }
                  )
                  if (!result.ok && !guard.isHalted) {
                    useStateIdentity(reasonerIdentity)
                    emitVisionStep(
                      taskId,
                      'The grounding specialist could not recover the action. Escalating to the heavy reasoner.'
                    )
                    const currentTask = getTaskRun(taskId)
                    result = await recoverWithVision(
                      {
                        taskId,
                        steps: currentTask?.steps ?? [...recovery.steps],
                        ...(currentTask?.stepDetails?.length
                          ? { stepDetails: currentTask.stepDetails }
                          : {}),
                        plan,
                        ...(recovery.guidance.length ? { guidance: [...recovery.guidance] } : {}),
                        summary: result.detail ?? recovery.summary,
                        currentStep: recovery.currentStep,
                        currentAction: 'Resolving the action with the heavy reasoner'
                      },
                      {
                        guard,
                        request,
                        queuedGuidance,
                        returnAfterAction: true,
                        reasonerOnly: true
                      }
                    )
                  }
                  const progress = taskExecutionPlanProgress(getTaskRun(taskId)?.steps ?? [])
                  const controlStatus = guard.snapshot().status
                  return {
                    ok: result.ok,
                    ...(!result.ok ? { detail: result.detail } : {}),
                    ...(result.performedActions?.some(submitsDraft)
                      ? { submittedDraft: true }
                      : {}),
                    ...(result.ok && controlStatus === 'completed'
                      ? {
                          completed: true,
                          summary: 'Vision recovery completed the requested action.'
                        }
                      : {}),
                    ...(progress ? { activePhaseIndex: progress.activePhaseIndex } : {})
                  }
                }
              }
            : {}),
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
            recordComputerUseMetric('axSteps')
            if (observation.result === 'actuated') recordComputerUseMetric('actions')
            persistAxObservation(taskId, goal, { ...observation, frame: observationFrame })
          }
        })
      let result =
        settings.modelStrategy === 'decision_plus_specialist' ||
        settings.modelStrategy === 'decision_plus_reasoning'
          ? await withDecisionModel(runLoop)
          : await runLoop()
      if (result.recovery === 'vision') {
        result = {
          ok: false,
          summary:
            'Computer Use could not make progress. Vision recovery is unavailable. Check that a vision model is installed, then retry Computer Use.',
          steps: result.steps
        }
      }
      if (!result.ok && !guard.isHalted) guard.fail(result.summary)
      const finalStatus = automationTaskReadStatus(guard.automationStatus)
      emitVisionState({
        taskId,
        journeyId,
        ...axStateIdentity,
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
      // Project the terminal state after the guard changes. A capture failure first
      // reports its detailed recovery trace while the guard is still running, so the
      // controller correctly rejects that early terminal projection as stale.
      emitVisionState({
        taskId,
        journeyId,
        ...axStateIdentity,
        goal,
        status: finalStatus,
        phase:
          finalStatus === 'done' ? 'complete' : finalStatus === 'failed' ? 'failed' : 'stopped',
        currentStep: liveStep,
        currentAction: summary,
        summary
      })
      return finalStatus === 'done'
        ? { ok: true, summary, steps: [] }
        : { ok: false, summary, steps: [] }
    } finally {
      if (usesDecisionRuntime && !parseRemoteVisionModelId(decisionModelId)) {
        await decisionRuntime.shutdown()
      }
      releaseGuidance()
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
