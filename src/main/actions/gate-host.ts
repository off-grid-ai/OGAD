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

/** What the inline chat card needs to render and resolve one gate. */
export interface InlineGateRequest {
  actionId: string
  actionType: string
  kind: ActionKind
  title: string
  args: Record<string, unknown>
  risk: string
  payloadHash: string
  source: string
}

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

/**
 * The inline gate surface (Approval UX v2): when the app registers an
 * emitter, gated actions with no pro queue listening PARK and render as a
 * card in the chat instead of auto-running. Unregistered (tests, headless),
 * the free-build behaviour stays run-now - the safe, unchanged default.
 *
 * Multiple subscribers, not one: the same parked gate fans out to every
 * surface that wants it - the desktop chat card (actions-ipc broadcasts to
 * renderer windows) AND pro's mesh forwarder (sends it to paired phones so the
 * approval can be given from a phone's chat). Each resolves the ONE engine gate
 * via resolveActionGate; the first verdict wins, the rest are no-ops.
 */
const inlineSurfaces = new Set<(request: InlineGateRequest) => void>()

export function registerInlineGateSurface(emit: (request: InlineGateRequest) => void): () => void {
  inlineSurfaces.add(emit)
  return () => {
    inlineSurfaces.delete(emit)
  }
}

/** Is any inline surface listening? Drives the park-vs-run-now decision. */
function hasInlineSurface(): boolean {
  return inlineSurfaces.size > 0
}

/** Fan a parked gate out to every registered inline surface. */
function emitInline(request: InlineGateRequest): void {
  for (const emit of inlineSurfaces) {
    emit(request)
  }
}

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

export function registerApprovalModeProvider(
  provider: () => ComputerApprovalMode
): () => void {
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

/** The rails that take over the user's cursor and keyboard. */
function isComputerRail(rail: Rail | undefined): boolean {
  return rail === 'accessibility' || rail === 'vision'
}

/** The action types that SEND on the user's behalf (iMessage, email). A send is
 *  irreversible and has no reliable read-back, so a wrong one cannot be undone
 *  or even verified - the user confirms before it leaves. */
const SEND_ACTION_TYPES: ReadonlySet<string> = new Set(['message', 'email'])

/** The approval policy, in one place: COMPUTER-USE tasks gate (the
 *  accessibility / vision rails take over the user's cursor and keyboard) and
 *  SENDS gate (irreversible, invisible until too late). Everything else runs
 *  without a prompt: reads are safe, undoable mutations (calendar, reminders)
 *  auto-run with the Undo chip, and web_task acts inside Off Grid's own watched
 *  browser pane - supervised by design, never touching the user's cursor. */
export function needsApproval(action: { rail?: Rail; type: string }): boolean {
  return isComputerRail(action.rail) || SEND_ACTION_TYPES.has(action.type)
}

/** The GateCallback the engine host is constructed with. */
export async function gateHost({ action }: { action: ActionRecord }): Promise<GateDecision> {
  // The env flag bypasses the gate entirely, for headless testing.
  if (approvalBypassed() || !needsApproval(action)) {
    return { kind: 'approve' }
  }
  // The user's Sync-sharing policy: "Auto-approve" runs COMPUTER-USE tasks with
  // no prompt (they still journal, and the outcome shows in chat). It never
  // covers sends - those ask every time; the toggle's scope is computer use.
  if (isComputerRail(action.rail) && computerApprovalMode() === 'auto') {
    return { kind: 'approve' }
  }
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
  // Park (and render the inline chat card) whenever a human is needed - which is
  // either when the pro queue accepted the gate (queued === true) OR when nobody
  // queued but an inline surface is registered. The pro-queue notification and the
  // in-chat card are two VIEWS of the ONE engine gate: whichever the user acts on
  // calls resolveActionGate for the same actionId (idempotent), and the other view
  // settles on the outcome broadcast. This is the "migration" the surface was built
  // for - a chat-initiated computer-use task is approvable right where it was asked.
  // Park BEFORE emitting so a same-tick resolve always finds the pending entry.
  if (queued === true || hasInlineSurface()) {
    return new Promise<GateDecision>((resolve) => {
      pending.set(action.id, resolve)
      notifyParked(action.id)
      emitInline({
        actionId: action.id,
        actionType: action.type,
        kind: railToKind(action.rail),
        title: action.intent,
        args: action.args,
        risk: action.risk,
        payloadHash: action.payloadHash,
        source: action.source
      })
    })
  }
  // Nothing queued and no inline surface (tests, headless): the unchanged
  // behaviour is to run. The engine still verifies.
  return { kind: 'approve' }
}
