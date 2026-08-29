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
  type ExecuteResult
} from '@offgrid/use'
import { getDB } from '../database'
import { hasHook, HOOKS } from '../bootstrap/hookRegistry'
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
import { withGrounder } from '../vision/grounder-loader'
import { getComputerUseSettings } from '../computer-use-settings'
import { isProEntitled } from '../licensing/license-service'
import { callConnectorTool } from '../mcp'
import { makeConnectorRailExecutor } from './connector-rail'
import { withRemoteScreenGate } from './remote-screen-gate'

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
  // The vision rail: computer_task, the supervised tier. Registered so the
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
  // created lazily on first computer_task.
  const visionExecute = makeVisionRailExecutor({
    runTask: (goal, taskId, journeyId) => getVisionRailHost().runTask(goal, taskId, journeyId)
  })
  // The grounder-vision executor: swap in UI-TARS (evict the chat model), run the
  // vision rail, restore the chat model - the tier-3 fallback. The swap/run/swap
  // wall-clock is logged so a computer_task's cost is attributable (the AX-vs-
  // grounder A/B). OFFGRID_GROUNDER=0 keeps the current model (no swap) for a
  // grounder-format A/B without paying the reload.
  const runGroundedVision = async (action: ActionRecord): Promise<ExecuteResult> => {
    if (process.env.OFFGRID_GROUNDER === '0') {
      return visionExecute(action)
    }
    const { result, timing } = await withGrounder(() => visionExecute(action))
    console.log(
      `[computer-task] grounder rail: skippedSwap=${timing.skippedSwap} swapInMs=${timing.swapInMs} runMs=${timing.runMs} swapOutMs=${timing.swapOutMs} totalMs=${timing.swapInMs + timing.runMs + timing.swapOutMs}`
    )
    return result
  }
  const groundedVisionExecute = withRemoteScreenGate('computer_use', runGroundedVision)
  // computer_task is TIERED: try the accessibility rail first (free, any chat
  // model, most native apps), and fall through to the grounder-vision rail only
  // when AX can't see the controls. OFFGRID_COMPUTER_RAIL=ax|vision forces one
  // rail for the A/B; unset = the real tiered behaviour.
  const computerTaskTiers: ComputerTaskTiers = {
    routingSnapshot: (goal) => getAxRailHost().routingSnapshot(goal),
    runAx: (goal, taskId, journeyId, app, initial) =>
      getAxRailHost().runTask(goal, taskId, app, initial, journeyId),
    visionExecute: groundedVisionExecute
  }
  const computerTaskExecute = (action: ActionRecord): Promise<ExecuteResult> => {
    const selectedRail =
      process.env.OFFGRID_COMPUTER_RAIL ??
      (getComputerUseSettings().modelStrategy === 'separate_specialist' ? 'vision' : undefined)
    return makeComputerTaskExecutor(computerTaskTiers, {
      forcedRail: parseForcedRail(selectedRail)
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
          return browserExecute(action)
        }
        if (rail === 'connector') {
          return connectorExecute(action)
        }
        if (rail === 'vision') {
          if (!isProEntitled()) {
            return { ok: false, detail: 'Computer Use requires Off Grid AI Pro.' }
          }
          // computer_task: accessibility-first, vision as the fallback tier.
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
      return worker.waitForOutcome(actionId, timeoutMs)
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
