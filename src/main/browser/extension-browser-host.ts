// web_use in the user's default browser, through the paired extension.
//
// Same task as the in-app browser (BrowserHost): the same execution plan, the same Playwright
// semantic loop over the same relay, the same guard, task history, progress and Stop. Only
// the pages differ: they are tabs in the user's own browser (extension-tab-pages.ts), so the
// user watches the work where they browse, signed in as themselves. There is no in-app pane.
//
// The visual fallback (canvas, maps, remote desktops) needs OGAD's own view, so here a page
// that needs it ends the task with that reason instead of guessing.
//
// Chromium tabs are driven by Playwright over the debugger protocol, and from inside the page
// while Chrome refuses the debugger (debugger-fallback-session.ts). Firefox has no debugger for
// extensions, so there the loop's Playwright tools are always answered by the extension in the
// page (extension-snapshot-session.ts); openTaskSession picks from what the browser reports.

import { automationTaskReadStatus } from '@offgrid/automation'
import { encodeTaskPhase } from '../../shared/task-execution-plan'
import type { BrowserLink } from '../extension-bridge/bridge-socket'
import { getTaskExecutionDevice, recordTaskRun, reportTaskProgress } from '../tasks/task-history'
import { registerTaskGuideHandler, TASK_GUIDANCE_TRACE } from '../tasks/task-guide'
import { prepareTaskExecutionPlan } from '../tasks/task-execution-plan-service'
import { retryPlanningGoal } from '../tasks/task-retry'
import {
  controlVisionTask,
  registerVisionSession,
  waitForVisionUser
} from '../vision/vision-controller'
import { VisionGuard } from '../vision/vision-guard'
import { BrowserDriver } from './browser-driver'
import {
  runBrowserPlaywrightTask,
  type BrowserPlaywrightTaskInput
} from './browser-playwright-task'
import type { BrowserRailHost, BrowserTaskRequest, WebTaskResult } from './browser-rail'
import { ElectronPlaywrightRelay } from './electron-playwright-relay'
import { createExtensionPageProvider, type ExtensionTabContents } from './extension-tab-pages'
import { ExtensionSnapshotSession } from './extension-snapshot-session'
import {
  DebuggerFallbackSession,
  type DebuggerConnection,
  type PageControl
} from './debugger-fallback-session'
import { PlaywrightMcpSession, type SemanticPageSession } from './playwright-mcp-session'

const START_URL = 'https://www.google.com'

type PageProvider = ReturnType<typeof createExtensionPageProvider>

export interface TaskSession {
  session: SemanticPageSession
  /** The pointer overlay; null where the page is driven from inside (no debugger). */
  driver: () => BrowserDriver | null
  close: () => Promise<void>
}

/** Said in the task's steps when control moves between the debugger and the page. */
export const CONTROL_STEPS: Record<PageControl, string> = {
  page: 'Chrome blocked debugger control because another extension (often a password manager) added a frame to this page. Continuing with page controls until it goes.',
  debugger: 'Debugger control is back.'
}

/** Attach Chrome's debugger to the task tab and start Playwright MCP over it. */
async function connectDebugger(
  pages: PageProvider,
  tab: () => ExtensionTabContents,
  front: boolean
): Promise<DebuggerConnection> {
  const relay = new ElectronPlaywrightRelay(pages)
  const playwright = new PlaywrightMcpSession(relay, () => tab().tabId)
  const target = tab()
  const close = async (): Promise<void> => {
    await playwright.close().catch(() => undefined)
    await relay.stop().catch(() => undefined)
  }
  try {
    target.debugger.attach()
    // Await Chrome's attachment before starting MCP, including its permission refusal.
    await target.debugger.sendCommand('Target.getTargetInfo')
    // A tab the task opened itself is put in front once, as OpenClaw does. A tab in the
    // background draws no frames, and every click then waits out its 45s timeout for the
    // element to be stable (found live). The user's own tab is left where it is.
    if (front) await target.debugger.sendCommand('Page.bringToFront').catch(() => undefined)
    await playwright.connect()
  } catch (error) {
    console.warn('[web-use][debugger] attach refused', {
      tabId: target.tabId,
      error: error instanceof Error ? error.message : String(error)
    })
    await close()
    target.debugger.detach()
    throw error
  }
  return { session: playwright, close }
}

/**
 * Drive the task tab the way this browser allows: Playwright over the debugger protocol where
 * it has one (Chromium), falling back to the extension's in-page answers while Chrome refuses
 * the debugger; in-page only where there is none (Firefox).
 */
export async function openTaskSession(
  link: BrowserLink,
  pages: PageProvider,
  tab: ExtensionTabContents,
  onStep: (note: string) => void = () => undefined,
  /** The task opened this tab itself: bring it in front once. */
  front = false
): Promise<TaskSession> {
  const caps = (await link.request('browser.caps')) as { cdp?: unknown } | null
  const current = (): ExtensionTabContents => pages.active() ?? tab
  const page = new ExtensionSnapshotSession(link, () => current().tabId)
  if (caps?.cdp !== true) {
    return { session: page, driver: () => null, close: async () => undefined }
  }
  const session = new DebuggerFallbackSession({
    connect: () => connectDebugger(pages, current, front),
    page,
    onSwitch: (to) => onStep(CONTROL_STEPS[to])
  })
  return {
    session,
    driver: () => (session.usesDebugger() ? new BrowserDriver(current().transport()) : null),
    close: () => session.close()
  }
}

/** The page's content the planner gets, at most: enough for its controls and headings. */
export const PLAN_SNAPSHOT_CHARS = 4000
const LOAD_WAITS = 5
const LOAD_WAIT_MS = 1000

/**
 * What the planner is told: the page the task starts on, and what that page shows. Found live:
 * planned from the goal alone, a plan named Name, Company and Website fields on a page with
 * one email box, and the step model rejected every proposal it then made.
 */
export async function startingState(
  tab: Pick<ExtensionTabContents, 'getURL' | 'getTitle'>,
  session: Pick<SemanticPageSession, 'snapshot'>,
  signal?: AbortSignal
): Promise<string> {
  const page = startingPage(tab)
  // A tab just opened may not have loaded: wait for a page with controls, a few seconds at most.
  // Found live: the planner read an empty page (no refs) and planned blind.
  let shown = await session.snapshot(signal).catch(() => null)
  for (
    let wait = 0;
    wait < LOAD_WAITS && shown && !shown.isError && !/\[ref=/.test(shown.text);
    wait += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, LOAD_WAIT_MS))
    shown = await session.snapshot(signal).catch(() => null)
  }
  if (!shown || shown.isError || !shown.text.trim()) return page
  const text =
    shown.text.length > PLAN_SNAPSHOT_CHARS
      ? `${shown.text.slice(0, PLAN_SNAPSHOT_CHARS)}\n(page cut here)`
      : shown.text
  return `${page}\n\nWhat the page shows now:\n${text}`
}

/** What the planner is told about the page the task starts on. */
export function startingPage(tab: Pick<ExtensionTabContents, 'getURL' | 'getTitle'>): string {
  const title = tab.getTitle().trim()
  return `The task starts in the browser tab at ${tab.getURL()}${title ? ` ("${title}")` : ''}. That page is already open: plan from it, with no step to open or reload it.`
}

/**
 * `startTabId`: the tab the browser offered for this task (browser-start-tab.ts). The task
 * starts there instead of in a new tab; without it, a new tab opens as before.
 */
export function createExtensionBrowserHost(
  link: () => BrowserLink | null,
  startTabId?: number
): BrowserRailHost {
  return {
    async runTask(request: BrowserTaskRequest): Promise<WebTaskResult> {
      const browser = link()
      if (!browser) {
        return {
          ok: false,
          summary: 'Your browser is not connected to Off Grid AI Desktop.',
          steps: [],
          takeovers: 0,
          finalUrl: ''
        }
      }
      return runInBrowser(browser, request, startTabId)
    }
  }
}

async function runInBrowser(
  link: BrowserLink,
  request: BrowserTaskRequest,
  startTabId: number | undefined
): Promise<WebTaskResult> {
  const { goal, url, taskId, journeyId, checkpoint } = request
  const guard = new VisionGuard({ taskId, kind: 'web_use' })
  const controller = new AbortController()
  const steps: string[] = checkpoint ? [...checkpoint.steps] : []
  const device = getTaskExecutionDevice()

  const setState = (status: Parameters<typeof recordTaskRun>[0]['status'], summary = ''): void => {
    recordTaskRun({
      taskId,
      journeyId,
      kind: 'web_use',
      title: goal,
      status,
      summary,
      steps: [...steps],
      executionDeviceId: device.id,
      executionDeviceName: device.name,
      lastUrl: pages.active()?.getURL() ?? ''
    })
  }
  const recordStep = (note: string): void => {
    steps.push(note)
    recordTaskRun({ taskId, journeyId, kind: 'web_use', title: goal, steps: [...steps] })
  }
  const pages = createExtensionPageProvider(link, () =>
    recordStep('The page opened a new tab. Continuing there.')
  )
  const releaseSession = registerVisionSession(taskId, guard, controller, (_s, status, action) =>
    setState(status, action)
  )
  const guidance: string[] = [...(checkpoint?.guidance ?? [])]
  const releaseGuidance = registerTaskGuideHandler(taskId, (text) => {
    guidance.push(text)
    recordStep(TASK_GUIDANCE_TRACE)
    controlVisionTask('resume', taskId)
    return true
  })
  // Leaving the task must not leave the browser's "is debugging" bar up.
  const stopOnDisconnect = link.onClose(() => controller.abort('The browser disconnected.'))

  try {
    setState('running', `Working in ${link.browser.name}`)
    let tab: ExtensionTabContents
    if (startTabId === undefined) {
      const start = url ?? START_URL
      tab = await pages.open(start)
      recordStep(`opened ${start} in ${link.browser.name}`)
    } else {
      // The user's own tab, left where it is unless the task names a page.
      tab = await pages.adopt(startTabId, taskId, url)
      recordStep(`working in your tab in ${link.browser.name}`)
    }
    const task = await openTaskSession(link, pages, tab, recordStep, startTabId === undefined)
    // Planning can take half a minute on a local model; say so instead of looking idle.
    if (!checkpoint?.plan) {
      reportTaskProgress({
        taskId,
        journeyId,
        kind: 'web_use',
        title: goal,
        status: 'running',
        currentAction: 'Planning the task'
      })
    }
    const plan =
      checkpoint?.plan ??
      (await prepareTaskExecutionPlan(
        {
          goal: retryPlanningGoal(goal, checkpoint),
          surface: 'web',
          // The page the task starts on, so the plan begins from it. Without it a plan opened
          // with "Navigate to the sign-up page" while the user was on it, and the reload
          // cleared what was filled.
          currentState: await startingState(tab, task.session, controller.signal),
          signal: controller.signal
        },
        recordStep
      ))
    const input: BrowserPlaywrightTaskInput = {
      goal,
      plan,
      session: task.session,
      guard,
      activeDriver: task.driver,
      activeUrl: () => (pages.active() ?? tab).getURL(),
      waitForUser: (why, signal) => waitForVisionUser(taskId, why, signal),
      takeGuidance: () => guidance.splice(0),
      onStep: recordStep,
      onPhase: (phaseId) => recordStep(encodeTaskPhase(phaseId)),
      onProgress: (currentStep, phase, action) =>
        reportTaskProgress({
          taskId,
          journeyId,
          kind: 'web_use',
          title: goal,
          status: 'running',
          phase,
          currentStep,
          currentAction: action
        }),
      signal: controller.signal
    }
    const semantic = await runBrowserPlaywrightTask(input).finally(task.close)

    const finalUrl = (pages.active() ?? tab).getURL()
    if ((semantic.fallback || !semantic.ok) && !guard.isHalted) guard.fail(semantic.summary)
    else if (semantic.ok && guard.automationStatus !== 'completed') {
      guard.fail('Web Use ended without a verified completion state.')
    }
    const status = automationTaskReadStatus(guard.automationStatus)
    const ok = semantic.ok && !semantic.fallback && status === 'done'
    const summary = ok ? semantic.summary : guard.snapshot().failure || semantic.summary
    setState(status, summary)
    return { ok, summary, steps: [...steps], takeovers: semantic.handoffs, finalUrl }
  } catch (error) {
    const detail =
      controller.signal.aborted && typeof controller.signal.reason === 'string'
        ? controller.signal.reason
        : error instanceof Error
          ? error.message
          : String(error)
    recordStep(`error: ${detail}`)
    const summary = `Web Use stopped: ${detail}`
    if (!guard.isHalted) guard.fail(summary)
    setState(automationTaskReadStatus(guard.automationStatus), summary)
    return { ok: false, summary, steps: [...steps], takeovers: 0, finalUrl: '' }
  } finally {
    stopOnDisconnect()
    releaseGuidance()
    releaseSession()
    await pages.closeAll()
  }
}
