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
import { makeUseDriver } from './use-driver'
import { makeSemanticRailExecutor } from './semantic-rail'
import { runNativeAction } from './native-helper'
import { gateHost, onGateParked, whenActionParked } from './gate-host'
import { createActionWorker, type ActionWorker } from './use-worker'

export interface ActionsRuntime {
  propose(
    input: unknown,
    meta: { source: ActionSource; sourceRef?: string }
  ): Promise<ProposeOutcome>
  waitForOutcome(actionId: string, timeoutMs: number): Promise<TickOutcome | undefined>
  whenParked(actionId: string): Promise<void>
  kick(): void
  /** True when a pro approval queue is listening - the chat tool keeps the
   *  legacy path then, so an unmigrated pro build behaves exactly as today. */
  approvalHookActive(): boolean
}

function buildRegistry(): HandlerRegistry {
  const registry = new HandlerRegistry()
  // R1: every handler runs the semantic rail; verification starts as the
  // executor's own verdict (none_fuzzy). Box 14 upgrades calendar and
  // reminders to read-back verification.
  const semantic = [
    { type: 'calendar', defaultRisk: 'mutate' },
    { type: 'reminder', defaultRisk: 'mutate' },
    { type: 'message', defaultRisk: 'mutate' },
    { type: 'email', defaultRisk: 'mutate' },
    { type: 'open', defaultRisk: 'navigate' },
    { type: 'lookup', defaultRisk: 'read' }
  ] as const
  for (const handler of semantic) {
    registry.register({
      type: handler.type,
      rail: 'semantic',
      defaultRisk: handler.defaultRisk,
      verification: 'none_fuzzy'
    })
  }
  return registry
}

let runtime: ActionsRuntime | null = null

/** Lazy singleton: built on first use so the DB and helper exist by then. */
export function getActionsRuntime(): ActionsRuntime {
  if (runtime) {
    return runtime
  }

  const semanticExecute = makeSemanticRailExecutor(runNativeAction)
  const engine = new UseEngine({
    driver: makeUseDriver(getDB()),
    registry: buildRegistry(),
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
    approvalHookActive: () =>
      hasHook(HOOKS.actionsProposeApproval) || hasHook(HOOKS.legacyMcpProposeApproval)
  }
  return runtime
}
