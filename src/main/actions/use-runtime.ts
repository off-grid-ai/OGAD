/**
 * The actions runtime - the app's one composition of the @offgrid/use engine
 * (R1 box 13). Electron-bound wiring only; every part it assembles is a
 * tested, injectable module: the app DB via makeUseDriver, the semantic rail
 * over runNativeAction, the gate host on the approval seam, and the park-
 * aware worker.
 *
 * Lease policy: ticks hold their queue lease while an action waits at the
 * gate, so visibility is set LONG (a day) and provably-stale leases from a
 * previous process are cleared at startup instead (releaseAll - safe because
 * the app is single-instance, so there is never a second live worker).
 */
import {
  HandlerRegistry,
  UseEngine,
  type ActionSource,
  type ProposeOutcome,
  type Rail,
  type TickOutcome,
  type ActionRecord,
  type ExecuteResult,
  type TerminalChatActionOutcome
} from '@offgrid/use'
import { getDB } from '../database'
import { callHook, hasHook, HOOKS, type ChatActionResult } from '../bootstrap/hookRegistry'
import { shell } from 'electron'
import { makeUseDriver } from './use-driver'
import { makeSemanticRailExecutor } from './semantic-rail'
import { makeOutlookNativeReader, makeWindowsSemanticRailExecutor } from './semantic-rail-win'
import { runPowerShell } from './win-powershell'
import { makeReadBackVerifiers } from './verification'
import { runNativeAction } from './native-helper'
import { gateHost, onActionParked, onGateParked, whenActionParked } from './gate-host'
import { createActionWorker, type ActionWorker } from './use-worker'
import { makeBrowserRailExecutor, registerBrowserRail } from '../browser/browser-rail'
import { getBrowserRailHost } from '../browser/browser-host'
import { makeVisionRailExecutor, registerVisionRail } from '../vision/vision-rail'
import { getVisionRailHost } from '../vision/vision-host'
import {
  makeComputerTaskExecutor,
  parseForcedRail,
  type ComputerTaskTiers
} from '../accessibility/ax-rail'
import { getAxRailHost } from '../accessibility/ax-host'
import { isProEntitled } from '../licensing/license-service'
import { callConnectorTool } from '../mcp'
import { makeConnectorRailExecutor } from './connector-rail'
import { withRemoteScreenGate } from './remote-screen-gate'
import { getTaskExecutionDevice, recordTaskRun } from '../tasks/task-history'
import { taskLaunchFromActionArgs } from '../tasks/task-launch-identity'
import { taskKindForActionType } from '../tools/nativeActionToolExtension-logic'

export interface ActionsRuntime {
  propose(
    input: unknown,
    meta: { source: ActionSource; sourceRef?: string }
  ): Promise<ProposeOutcome>
  /** Reverse a done action through its handler's undo capability. */
  undo(record: ActionRecord): Promise<{ ok: boolean; detail?: string }>
  /** Every outcome as it lands, with whether it can be undone - the chat
   *  card and Undo chip feed. Returns unsubscribe. */
  onOutcome(listener: (event: { outcome: TickOutcome; undoable: boolean }) => void): () => void
  waitForOutcome(actionId: string, timeoutMs: number): Promise<TickOutcome | undefined>
  /** Read-only terminal facts owned by the action engine. Projection consumers may reconcile them;
   * they cannot execute or mutate an Action through this port. */
  listTerminalChatActionResults(): Promise<readonly ChatActionResult[]>
  whenParked(actionId: string): Promise<void>
  onParked(actionId: string, listener: () => void): () => void
  kick(): void
  /** True when a pro approval queue is listening - the chat tool keeps the
   *  legacy path then, so an unmigrated pro build behaves exactly as today. */
  approvalHookActive(): boolean
}

export function buildRegistry(run: typeof runNativeAction): HandlerRegistry {
  const registry = new HandlerRegistry()
  const verifiers = makeReadBackVerifiers(run)
  /** Undo = delete the exact effect the create returned (Approval UX v2):
   *  the capability that makes these reversible, which is what lets them
   *  auto-run with a verified confirmation + Undo instead of a pre-gate. */
  const undoVia =
    (command: 'calendar.deleteEvent' | 'reminders.delete') =>
    async (action: ActionRecord): Promise<{ ok: boolean; detail?: string }> => {
      const res = await run({ command, args: { id: action.effectId } })
      return res.ok ? { ok: true } : { ok: false, detail: res.error }
    }
  // Calendar and reminders are observable: read back after create, so a
  // failed write retries once and "done" means the item is really there.
  registry.register({
    type: 'calendar',
    rail: 'semantic',
    defaultRisk: 'mutate',
    verification: 'read_back',
    verify: verifiers.calendar,
    undo: undoVia('calendar.deleteEvent')
  })
  registry.register({
    type: 'reminder',
    rail: 'semantic',
    defaultRisk: 'mutate',
    verification: 'read_back',
    verify: verifiers.reminder,
    undo: undoVia('reminders.delete')
  })
  // Sends have no reliable read-back ("did it send?"), so they are fuzzy
  // and single-attempt behind the gate - a wrong verify can never double-
  // send. open_url's launch result IS its verdict; lookups are reads.
  for (const handler of [
    { type: 'message', defaultRisk: 'mutate' },
    { type: 'email', defaultRisk: 'mutate' },
    { type: 'open', defaultRisk: 'navigate' },
    { type: 'lookup', defaultRisk: 'read' }
  ] as const) {
    registry.register({
      type: handler.type,
      rail: 'semantic',
      defaultRisk: handler.defaultRisk,
      verification: 'none_fuzzy'
    })
  }
  // The browser rail: web_use, on every platform (Electron CDP is the same
  // everywhere). Declared in the browser module so its rail/risk live there.
  registerBrowserRail(registry)
  // The vision rail: computer_use, the supervised tier. Registered so the
  // engine routes it; the host refuses cleanly until actuation is available,
  // and the tool is not offered to the model until then.
  registerVisionRail(registry)
  registry.register({
    type: 'connector',
    rail: 'connector',
    defaultRisk: 'mutate',
    verification: 'none_fuzzy'
  })
  return registry
}

/** The one place a platform picks an implementation - exported so both arms
 *  are testable without faking process.platform. */
export function pickByPlatform<T>(platform: NodeJS.Platform, win: T, mac: T): T {
  return platform === 'win32' ? win : mac
}

function recordAuthenticatedTaskLaunch(
  action: ActionRecord,
  kind: 'web_use' | 'computer_use'
): void {
  const launch = taskLaunchFromActionArgs(action.args)
  if (!launch) return
  const executionDevice = getTaskExecutionDevice()
  const args = action.args as Record<string, unknown>
  const title = typeof args.goal === 'string' && args.goal.trim() ? args.goal : action.intent
  recordTaskRun({
    taskId: action.id,
    journeyId: action.sourceRef ?? action.id,
    launchId: launch.launchId,
    requestingDeviceId: launch.requestingDeviceId,
    kind,
    title,
    executionDeviceId: executionDevice.id,
    executionDeviceName: executionDevice.name
  })
}

/** One-way projection from the durable action engine to a Chat owner's result observer. */
function chatActionResultFromRecord(
  actionId: string,
  outcome: 'done' | 'rejected' | 'needs_help',
  record: ActionRecord
): ChatActionResult | null {
  const conversationId = record.source === 'chat' ? record.sourceRef?.trim() : ''
  if (!conversationId) return null
  const detail = record.attemptLog.at(-1)?.detail?.trim()
  const summary =
    detail ||
    (outcome === 'rejected'
      ? 'The action was declined and did not run.'
      : outcome === 'needs_help'
        ? 'The action ran but could not be confirmed.'
        : record.intent)
  return {
    actionId,
    conversationId,
    status: outcome === 'done' ? 'done' : 'failed',
    summary
  }
}

export function chatActionResultFromOutcome(outcome: TickOutcome): ChatActionResult | null {
  if (outcome.outcome === 'poisoned' || outcome.outcome === 'edited') return null
  return chatActionResultFromRecord(outcome.id, outcome.outcome, outcome.record)
}

export function chatActionResultFromTerminalOutcome(
  outcome: TerminalChatActionOutcome
): ChatActionResult | null {
  return chatActionResultFromRecord(outcome.actionId, outcome.outcome, outcome.record)
}

export function observeActionOutcome(outcome: TickOutcome): void {
  const chatResult = chatActionResultFromOutcome(outcome)
  if (chatResult) {
    const reportProjectionFailure = (error: unknown): void => {
      console.error('[actions] Chat action result projection failed', error)
    }
    try {
      const projection = callHook<unknown>(HOOKS.actionsObserveChatActionResult, chatResult)
      void Promise.resolve(projection).catch(reportProjectionFailure)
    } catch (error) {
      // Projection is downstream of the committed action. Its failure must not turn a completed
      // external effect into a rejected wait result or invite an unsafe retry.
      reportProjectionFailure(error)
    }
  }
  if (outcome.outcome === 'poisoned') return
  try {
    const kind = taskKindForActionType(outcome.record.type)
    if (!kind || outcome.outcome === 'done') return
    const detail = outcome.record.attemptLog.at(-1)?.detail?.trim()
    const status = outcome.outcome === 'rejected' ? 'failed' : 'waiting'
    const summary =
      detail ||
      (outcome.outcome === 'rejected'
        ? 'The task was declined and did not run.'
        : outcome.outcome === 'edited'
          ? 'The task is waiting for changes.'
          : 'The task ran but could not be confirmed.')
    recordTaskRun({
      taskId: outcome.id,
      kind,
      title: outcome.record.intent,
      status,
      summary
    })
  } catch (error) {
    console.error('[actions] Task action result projection failed', error)
  }
}

let runtime: ActionsRuntime | null = null

/** Lazy singleton: built on first use so the DB and helper exist by then. */
export function getActionsRuntime(): ActionsRuntime {
  if (runtime) {
    return runtime
  }

  // The platform decides which semantic rail implements the port - the one
  // concrete choice, made once here; nothing above it branches on an OS.
  const registry = buildRegistry(
    pickByPlatform(process.platform, makeOutlookNativeReader(runPowerShell), runNativeAction)
  )
  const semanticExecute = pickByPlatform(
    process.platform,
    makeWindowsSemanticRailExecutor({
      runPs: runPowerShell,
      openUrl: async (url: string) => {
        await shell.openExternal(url)
        return { ok: true as const, result: {} }
      }
    }),
    makeSemanticRailExecutor(runNativeAction)
  )
  // The browser rail's live host (WebContentsView + CDP + model + watched
  // pane) is created lazily on first web_use so a session that never runs one
  // pays nothing for it.
  const rawBrowserExecute = makeBrowserRailExecutor({
    runTask: (request) => getBrowserRailHost().runTask(request)
  })
  // BrowserHost owns the Web Use model lifecycle. It resolves the adapter and
  // records the model identity only after the specialist swap completes. A
  // second wrapper here caused nested swaps and restored Chat too early.
  const browserExecute = withRemoteScreenGate('web_use', rawBrowserExecute)
  const connectorExecute = makeConnectorRailExecutor(callConnectorTool)
  // The vision rail's live host (screen capture + actuation + grounding model),
  // created lazily on first computer_use.
  const visionExecute = makeVisionRailExecutor({
    runTask: (goal, taskId, journeyId) => getVisionRailHost().runTask(goal, taskId, journeyId)
  })
  // VisionHost owns the selected model strategy for the whole task. This keeps
  // specialist-resident and per-step hybrid swaps behind the same session port.
  const groundedVisionExecute = withRemoteScreenGate('computer_use', visionExecute)
  // computer_use is TIERED: try the accessibility rail first (free, any chat
  // model, most native apps), and fall through to the grounder-vision rail only
  // when AX can't see the controls. OFFGRID_COMPUTER_RAIL=ax|vision forces one
  // rail for the A/B; unset = the real tiered behaviour.
  const computerTaskTiers: ComputerTaskTiers = {
    routingSnapshot: (goal) => getAxRailHost().routingSnapshot(goal),
    runAx: (goal, taskId, journeyId, app, initial, allowVisionRecovery) =>
      getAxRailHost().runTask(goal, taskId, app, initial, journeyId, allowVisionRecovery),
    visionExecute: groundedVisionExecute
  }
  const computerTaskExecute = (action: ActionRecord): Promise<ExecuteResult> => {
    return makeComputerTaskExecutor(computerTaskTiers, {
      // Model strategy selects which model handles a vision FALLBACK. It must
      // never bypass verified native application controls. The environment
      // override remains available only for explicit rail diagnostics.
      forcedRail: parseForcedRail(process.env.OFFGRID_COMPUTER_RAIL)
    })(action)
  }
  const engine = new UseEngine({
    driver: makeUseDriver(getDB()),
    // Read-back verification reads the world back through the platform's own
    // surface: the Swift helper's list verbs on macOS, Outlook COM on
    // Windows - the same command names, so buildRegistry is unchanged.
    registry,
    device: {
      async execute(action: ActionRecord, rail: Rail) {
        if (rail === 'semantic') {
          return semanticExecute(action)
        }
        if (rail === 'browser') {
          if (!isProEntitled()) {
            return { ok: false, detail: 'Browser Use requires Off Grid AI Pro.' }
          }
          recordAuthenticatedTaskLaunch(action, 'web_use')
          return browserExecute(action)
        }
        if (rail === 'connector') {
          return connectorExecute(action)
        }
        if (rail === 'vision') {
          if (!isProEntitled()) {
            return { ok: false, detail: 'Computer Use requires Off Grid AI Pro.' }
          }
          recordAuthenticatedTaskLaunch(action, 'computer_use')
          // computer_use: accessibility-first, vision as the fallback tier.
          return computerTaskExecute(action)
        }
        return { ok: false, detail: `the '${rail}' rail is not built yet` }
      }
    },
    gate: gateHost,
    attemptTimeoutMs: 30_000, // the helper's own timeout is 20s
    visibilityMs: 24 * 60 * 60 * 1000
  })

  const worker: ActionWorker = createActionWorker(engine, { onParked: onGateParked })

  const ready = (async () => {
    await engine.init()
    await engine.queue.releaseAll() // stale leases from the previous process
    worker.kick() // resume anything the last session left behind
  })()

  // Scheduled actions become due while the app idles; a slow heartbeat
  // re-kicks the drain. unref'd so it never holds the process open.
  const heartbeat = setInterval(() => worker.kick(), 30_000)
  heartbeat.unref()

  runtime = {
    async propose(input, meta) {
      await ready
      const outcome = await engine.propose(input, meta)
      worker.kick()
      return outcome
    },
    async waitForOutcome(actionId, timeoutMs) {
      await ready
      const outcome = await worker.waitForOutcome(actionId, timeoutMs)
      if (outcome) observeActionOutcome(outcome)
      return outcome
    },
    async listTerminalChatActionResults() {
      await ready
      const outcomes = await engine.terminalChatOutcomes.list()
      return outcomes.flatMap((outcome) => {
        const result = chatActionResultFromTerminalOutcome(outcome)
        return result ? [result] : []
      })
    },
    whenParked: whenActionParked,
    onParked: onActionParked,
    kick: () => worker.kick(),
    undo: async (record) => {
      await ready
      return engine.undo(record)
    },
    onOutcome: (listener) =>
      worker.onOutcome((outcome) => {
        const undoable =
          outcome.outcome === 'done' &&
          !!outcome.record.effectId &&
          !!registry.get(outcome.record.type)?.undo
        listener({ outcome, undoable })
      }),
    approvalHookActive: () =>
      hasHook(HOOKS.actionsProposeApproval) || hasHook(HOOKS.legacyMcpProposeApproval)
  }
  return runtime
}
