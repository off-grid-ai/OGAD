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
  type ActionRecord
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
import { gateHost, onGateParked, whenActionParked } from './gate-host'
import { createActionWorker, type ActionWorker } from './use-worker'

export interface ActionsRuntime {
  propose(
    input: unknown,
    meta: { source: ActionSource; sourceRef?: string }
  ): Promise<ProposeOutcome>
  /** Reverse a done action through its handler's undo capability. */
  undo(record: ActionRecord): Promise<{ ok: boolean; detail?: string }>
  waitForOutcome(actionId: string, timeoutMs: number): Promise<TickOutcome | undefined>
  whenParked(actionId: string): Promise<void>
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
  const engine = new UseEngine({
    driver: makeUseDriver(getDB()),
    // Read-back verification reads the world back through the platform's own
    // surface: the Swift helper's list verbs on macOS, Outlook COM on
    // Windows - the same command names, so buildRegistry is unchanged.
    registry: buildRegistry(
      pickByPlatform(process.platform, makeOutlookNativeReader(runPowerShell), runNativeAction)
    ),
    device: {
      async execute(action: ActionRecord, rail: Rail) {
        if (rail !== 'semantic') {
          return { ok: false, detail: `the '${rail}' rail is not built yet (R1 ships semantic)` }
        }
        return semanticExecute(action)
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
  heartbeat.unref?.()

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
    kick: () => worker.kick(),
    undo: async (record) => {
      await ready
      return engine.undo(record)
    },
    approvalHookActive: () =>
      hasHook(HOOKS.actionsProposeApproval) || hasHook(HOOKS.legacyMcpProposeApproval)
  }
  return runtime
}
