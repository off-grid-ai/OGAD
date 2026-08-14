/**
 * The gate host - the engine's approval callback, wired to the existing
 * actions:proposeApproval seam (R1 box 11).
 *
 * Two contracts meet here. The engine's gate AWAITS a decision (approve /
 * edit / reject) bound to the exact payload. The app's approval seam is
 * fire-and-queue: proposeActionApproval offers the action to the pro
 * approval queue and reports queued / not-queued / nobody-listening. The
 * bridge: propose with the action's id and payload hash on the request,
 * then park the decision in a pending registry that the approval UI (pro's
 * queue, or core's card) resolves via resolveActionGate(actionId, decision).
 *
 * Free build: nothing listens, so mutations keep the unchanged free
 * behaviour and run (the engine still verifies and journals them).
 *
 * Note on leases: tick() holds the queue lease while awaiting a human. On a
 * single-worker desktop that is safe - and if the app quits first, the
 * pending map dies with the process while the Action survives in the DB at
 * awaiting_approval, so the next launch re-offers it. Nothing is lost.
 */
import type { ActionRecord, GateDecision, Rail } from '@offgrid/use'
import { proposeActionApproval, type ActionKind } from './approval'

/** The engine's rails, translated to the approval UI's executor kinds. */
export function railToKind(rail: Rail | undefined): ActionKind {
  switch (rail) {
    case 'browser':
      return 'browser'
    case 'accessibility':
    case 'vision':
      return 'computer'
    case 'semantic':
    default:
      return 'native'
  }
}

const pending = new Map<string, (decision: GateDecision) => void>()
const parkedWaiters = new Map<string, Array<() => void>>()

/**
 * Resolves as soon as the action parks at the gate (immediately when it is
 * already parked). The chat tool races this against the action's outcome to
 * answer "pending approval" instead of blocking on a human.
 */
export function whenActionParked(actionId: string): Promise<void> {
  if (pending.has(actionId)) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const waiters = parkedWaiters.get(actionId) ?? []
    waiters.push(resolve)
    parkedWaiters.set(actionId, waiters)
  })
}

const parkListeners = new Set<() => void>()

/** Global "an action just parked at the gate" signal - the worker's cue to
 *  move on to the next due message instead of blocking on a human. */
export function onGateParked(listener: () => void): () => void {
  parkListeners.add(listener)
  return () => parkListeners.delete(listener)
}

function notifyParked(actionId: string): void {
  const waiters = parkedWaiters.get(actionId)
  if (waiters) {
    parkedWaiters.delete(actionId)
    for (const resolve of waiters) {
      resolve()
    }
  }
  for (const listener of parkListeners) {
    listener()
  }
}

/**
 * Called by the approval surface (IPC from the card, or pro's queue) with
 * the human's verdict. False when the id is unknown - the decision may have
 * arrived after a restart cleared the in-memory registry; the action will
 * be re-offered on its next tick.
 */
export function resolveActionGate(actionId: string, decision: GateDecision): boolean {
  const resolve = pending.get(actionId)
  if (!resolve) {
    return false
  }
  pending.delete(actionId)
  resolve(decision)
  return true
}

/** How many actions are parked waiting on a human - a health surface. */
export function pendingActionGateCount(): number {
  return pending.size
}

/** Drop a parked decision (tests, and future cancel-from-UI). */
export function abandonActionGate(actionId: string): boolean {
  return pending.delete(actionId)
}

/** The GateCallback the engine host is constructed with. */
export async function gateHost({ action }: { action: ActionRecord }): Promise<GateDecision> {
  const queued = proposeActionApproval({
    kind: railToKind(action.rail),
    title: action.intent,
    detail: JSON.stringify(action.args, null, 2),
    risk: action.risk,
    args: action.args,
    source: action.source,
    // Engine-specific fields the approval card needs to resolve the gate
    // and to show exactly what was bound.
    actionId: action.id,
    actionType: action.type,
    payloadHash: action.payloadHash
  })
  if (queued !== true) {
    // Nothing listening (free build), or the handler chose not to queue it:
    // the unchanged behaviour is to run. The engine still verifies.
    return { kind: 'approve' }
  }
  return new Promise<GateDecision>((resolve) => {
    pending.set(action.id, resolve)
    notifyParked(action.id)
  })
}
