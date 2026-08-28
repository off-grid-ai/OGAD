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
    case 'connector':
      return 'mcp'
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
const parkedListeners = new Map<string, Set<() => void>>()

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

/** Cancellable parked observer for a Chat tool that races terminal execution.
 *  Unlike the legacy Promise helper, an action that finishes directly leaves no waiter behind. */
export function onActionParked(actionId: string, listener: () => void): () => void {
  if (pending.has(actionId)) {
    queueMicrotask(listener)
    return () => undefined
  }
  const listeners = parkedListeners.get(actionId) ?? new Set<() => void>()
  listeners.add(listener)
  parkedListeners.set(actionId, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) parkedListeners.delete(actionId)
  }
}

const parkListeners = new Set<() => void>()

/** Fail-closed parse of a renderer-supplied decision - unknown shapes reject. */
export function parseGateDecision(input: unknown): GateDecision | null {
  if (typeof input !== 'object' || input === null) {
    return null
  }
  const kind = (input as Record<string, unknown>).kind
  if (kind === 'approve') {
    return { kind: 'approve' }
  }
  if (kind === 'reject') {
    const reason = (input as Record<string, unknown>).reason
    return { kind: 'reject', ...(typeof reason === 'string' ? { reason } : {}) }
  }
  if (kind === 'edit') {
    const args = (input as Record<string, unknown>).args
    if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
      return { kind: 'edit', args: args as Record<string, unknown> }
    }
  }
  return null
}

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
  const listeners = parkedListeners.get(actionId)
  if (listeners) {
    parkedListeners.delete(actionId)
    for (const listener of listeners) listener()
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

/** Testing/dev escape hatch: OFFGRID_AUTO_APPROVE=1 approves every gated action
 *  immediately, so the chat agent runs tasks with no approval prompt. Off by
 *  default - production and tests gate per the rule below. */
export function approvalBypassed(): boolean {
  return process.env['OFFGRID_AUTO_APPROVE'] === '1'
}

/** How computer-use approvals are handled, chosen by the user in Sync sharing:
 *  'ask' (the default) parks every task for approval; 'auto' runs it with no
 *  prompt. Distinct from approvalBypassed (a headless-test env flag) - this is a
 *  real, persisted user setting. Pro owns the setting + its toggle and registers
 *  a provider; with none registered (free build, tests) the safe default is ask. */
export type ComputerApprovalMode = 'auto' | 'ask'
let approvalModeProvider: (() => ComputerApprovalMode) | null = null

export function registerApprovalModeProvider(provider: () => ComputerApprovalMode): () => void {
  approvalModeProvider = provider
  return () => {
    if (approvalModeProvider === provider) {
      approvalModeProvider = null
    }
  }
}

export function computerApprovalMode(): ComputerApprovalMode {
  return approvalModeProvider?.() ?? 'ask'
}

/** Connector mutations and visual tasks enter the source-owned approval policy.
 *  Native semantic actions keep their existing risk-specific behavior. */
export function needsApproval(action: Pick<ActionRecord, 'rail'>): boolean {
  return (
    action.rail === 'connector' ||
    action.rail === 'browser' ||
    action.rail === 'accessibility' ||
    action.rail === 'vision'
  )
}

function isComputerRail(rail: Rail | undefined): boolean {
  return rail === 'accessibility' || rail === 'vision'
}

/** The existing Chat that owns an action, or null for Action Approval.
 *  This is the routing SSOT for direct Chat execution. */
export function approvalConversation(
  action: Pick<ActionRecord, 'source' | 'sourceRef'>
): string | null {
  const sourceRef = action.sourceRef?.trim()
  return action.source === 'chat' && sourceRef ? sourceRef : null
}

/** The GateCallback the engine host is constructed with. */
export async function gateHost({ action }: { action: ActionRecord }): Promise<GateDecision> {
  // Native semantic actions run straight through this gate. The env flag bypasses
  // source approval for headless testing.
  if (approvalBypassed() || !needsApproval(action)) {
    return { kind: 'approve' }
  }
  // The user's Sync-sharing policy: "Auto-approve" runs computer-use tasks with no
  // prompt (they still journal, and the outcome shows in chat); "Ask every time"
  // (the default) falls through to park for approval below.
  if (isComputerRail(action.rail) && computerApprovalMode() === 'auto') {
    return { kind: 'approve' }
  }
  const conversationId = approvalConversation(action)
  // A task invoked in Chat starts there immediately. Action Approval owns only tasks proposed
  // outside Chat; after approval, that owner creates the execution Chat and starts the task.
  if (conversationId !== null) return { kind: 'approve' }
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
  if (queued === true) {
    return new Promise<GateDecision>((resolve) => {
      pending.set(action.id, resolve)
      notifyParked(action.id)
    })
  }
  // Nothing queued and no inline surface (tests, headless): the unchanged
  // behaviour is to run. The engine still verifies.
  return { kind: 'approve' }
}
