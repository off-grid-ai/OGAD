/**
 * The gate host bridging the engine's awaitable gate to the app's
 * fire-and-queue approval seam. Guards: the free build keeps its unchanged
 * run-now behaviour, a queued action parks until the approval surface
 * resolves it, and the request the surface receives carries everything the
 * card needs (id, type, payload hash, mapped kind).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActionRecord } from '@offgrid/use'
import { HOOKS, registerHook, unregisterHook } from '../../bootstrap/hookRegistry'
import {
  abandonActionGate,
  approvalBypassed,
  computerApprovalMode,
  gateHost,
  needsApproval,
  onGateParked,
  parseGateDecision,
  pendingActionGateCount,
  railToKind,
  registerApprovalModeProvider,
  registerInlineGateSurface,
  resolveActionGate,
  whenActionParked,
  type InlineGateRequest
} from '../gate-host'

const record = (overrides: Partial<ActionRecord> = {}): ActionRecord =>
  ({
    type: 'reminder',
    intent: 'remind me to send the deck',
    args: { title: 'Send the deck' },
    risk: 'mutate',
    id: 'act_1',
    source: 'chat',
    payloadHash: 'a'.repeat(64),
    // Default to a COMPUTER-USE rail: only those gate now, so the parking tests
    // need one. Non-computer-use rails (browser/semantic) auto-approve.
    rail: 'accessibility',
    idempotencyKey: 'k',
    attempts: 0,
    attemptLog: [],
    state: 'awaiting_approval',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }) as ActionRecord

afterEach(() => {
  unregisterHook(HOOKS.actionsProposeApproval)
  unregisterHook(HOOKS.legacyMcpProposeApproval)
  abandonActionGate('act_1')
  abandonActionGate('act_2')
})

describe('railToKind', () => {
  it('maps the engine rails onto the approval kinds', () => {
    expect(railToKind('semantic')).toBe('native')
    expect(railToKind('browser')).toBe('browser')
    expect(railToKind('accessibility')).toBe('computer')
    expect(railToKind('vision')).toBe('computer')
    expect(railToKind(undefined)).toBe('native')
  })
})

describe('gateHost', () => {
  it('free build (nothing listening): approves immediately - unchanged behaviour', async () => {
    const decision = await gateHost({ action: record() })
    expect(decision).toEqual({ kind: 'approve' })
    expect(pendingActionGateCount()).toBe(0)
  })

  it('a handler that declines to queue also lets the action run', async () => {
    registerHook(HOOKS.actionsProposeApproval, () => false)
    const decision = await gateHost({ action: record() })
    expect(decision).toEqual({ kind: 'approve' })
  })

  it('a queued action parks until the approval surface resolves it', async () => {
    const seen = vi.fn(() => true)
    registerHook(HOOKS.actionsProposeApproval, seen)

    const parked = gateHost({ action: record() })
    expect(pendingActionGateCount()).toBe(1)

    expect(resolveActionGate('act_1', { kind: 'approve' })).toBe(true)
    await expect(parked).resolves.toEqual({ kind: 'approve' })
    expect(pendingActionGateCount()).toBe(0)
  })

  it('the request carries what the card needs: id, type, hash, mapped kind, args', async () => {
    let request: Record<string, unknown> = {}
    registerHook(HOOKS.actionsProposeApproval, (req: Record<string, unknown>) => {
      request = req
      return true
    })
    const parked = gateHost({ action: record({ rail: 'vision', risk: 'irreversible' }) })
    expect(request).toMatchObject({
      kind: 'computer',
      risk: 'irreversible',
      actionId: 'act_1',
      actionType: 'reminder',
      payloadHash: 'a'.repeat(64),
      title: 'remind me to send the deck',
      args: { title: 'Send the deck' },
      source: 'chat'
    })
    resolveActionGate('act_1', { kind: 'reject', reason: 'no' })
    await expect(parked).resolves.toEqual({ kind: 'reject', reason: 'no' })
  })

  it('reject and edit decisions pass through untouched', async () => {
    registerHook(HOOKS.actionsProposeApproval, () => true)
    const first = gateHost({ action: record() })
    resolveActionGate('act_1', { kind: 'edit', args: { title: 'Send the v2 deck' } })
    await expect(first).resolves.toEqual({ kind: 'edit', args: { title: 'Send the v2 deck' } })
  })

  it('resolving an unknown action reports false instead of throwing', () => {
    expect(resolveActionGate('act_ghost', { kind: 'approve' })).toBe(false)
  })

  it('falls back to the legacy mcp hook when the new one is unregistered', async () => {
    const legacy = vi.fn(() => true)
    registerHook(HOOKS.legacyMcpProposeApproval, legacy)
    const parked = gateHost({ action: record() })
    expect(legacy).toHaveBeenCalled()
    resolveActionGate('act_1', { kind: 'approve' })
    await parked
  })
})

describe('the park signals', () => {
  it('whenActionParked resolves immediately for an already-parked action', async () => {
    registerHook(HOOKS.actionsProposeApproval, () => true)
    const parked = gateHost({ action: record() })
    await whenActionParked('act_1') // already pending: resolves now
    resolveActionGate('act_1', { kind: 'approve' })
    await parked
  })

  it('whenActionParked resolves when the park happens later', async () => {
    registerHook(HOOKS.actionsProposeApproval, () => true)
    const waiting = whenActionParked('act_1')
    const parked = gateHost({ action: record() })
    await waiting
    resolveActionGate('act_1', { kind: 'approve' })
    await parked
  })

  it('onGateParked notifies global listeners and unsubscribe stops them', async () => {
    registerHook(HOOKS.actionsProposeApproval, () => true)
    let fired = 0
    const unsubscribe = onGateParked(() => {
      fired += 1
    })
    const first = gateHost({ action: record() })
    expect(fired).toBe(1)
    resolveActionGate('act_1', { kind: 'approve' })
    await first

    unsubscribe()
    const second = gateHost({ action: record({ id: 'act_2' }) })
    expect(fired).toBe(1)
    resolveActionGate('act_2', { kind: 'approve' })
    await second
  })

  it('pendingActionGateCount tracks parks and abandonActionGate drops one', () => {
    registerHook(HOOKS.actionsProposeApproval, () => true)
    void gateHost({ action: record() })
    expect(pendingActionGateCount()).toBe(1)
    expect(abandonActionGate('act_1')).toBe(true)
    expect(abandonActionGate('act_1')).toBe(false)
    expect(pendingActionGateCount()).toBe(0)
  })
})

describe('the inline gate surface (Approval UX v2)', () => {
  it('with a surface registered, a free-build gate parks and emits the card request', async () => {
    const requests: InlineGateRequest[] = []
    const unregister = registerInlineGateSurface((request) => requests.push(request))
    try {
      const parked = gateHost({ action: record({ risk: 'irreversible', rail: 'accessibility' }) })
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        actionId: 'act_1',
        actionType: 'reminder',
        kind: 'computer',
        risk: 'irreversible',
        title: 'remind me to send the deck',
        payloadHash: 'a'.repeat(64)
      })
      expect(pendingActionGateCount()).toBe(1)
      resolveActionGate('act_1', { kind: 'approve' })
      await expect(parked).resolves.toEqual({ kind: 'approve' })
    } finally {
      unregister()
    }
  })

  it('unregistering restores the run-now default', async () => {
    const unregister = registerInlineGateSurface(() => {})
    unregister()
    const decision = await gateHost({ action: record() })
    expect(decision).toEqual({ kind: 'approve' })
  })

  it('fans one parked gate out to EVERY registered surface (chat card + mesh forwarder)', async () => {
    // Two surfaces stand in for the desktop chat card and pro's phone-mesh forwarder.
    const card: string[] = []
    const mesh: string[] = []
    const offCard = registerInlineGateSurface((r) => card.push(r.actionId))
    const offMesh = registerInlineGateSurface((r) => mesh.push(r.actionId))
    try {
      const parked = gateHost({ action: record() })
      expect(card).toEqual(['act_1'])
      expect(mesh).toEqual(['act_1'])
      // A single resolve (from whichever surface) settles the one gate.
      expect(resolveActionGate('act_1', { kind: 'approve' })).toBe(true)
      await expect(parked).resolves.toEqual({ kind: 'approve' })
    } finally {
      offCard()
      offMesh()
    }
  })

  it('stops delivering to a surface once it unregisters, keeps delivering to the rest', async () => {
    const card: string[] = []
    const mesh: string[] = []
    const offCard = registerInlineGateSurface((r) => card.push(r.actionId))
    const offMesh = registerInlineGateSurface((r) => mesh.push(r.actionId))
    offMesh() // the phone forwarder goes away
    try {
      const parked = gateHost({ action: record() })
      expect(card).toEqual(['act_1'])
      expect(mesh).toEqual([]) // no longer receives
      resolveActionGate('act_1', { kind: 'approve' })
      await parked
    } finally {
      offCard()
    }
  })

  it('surfaces a queued gate in BOTH the pro queue and the inline card - one gate, two views', async () => {
    const requests: InlineGateRequest[] = []
    const unregister = registerInlineGateSurface((request) => requests.push(request))
    try {
      const proSaw = vi.fn(() => true)
      registerHook(HOOKS.actionsProposeApproval, proSaw)
      const parked = gateHost({ action: record() })
      // The pro queue was offered the gate AND the in-chat card was emitted for it.
      expect(proSaw).toHaveBeenCalledTimes(1)
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ actionId: 'act_1', kind: 'computer' })
      expect(pendingActionGateCount()).toBe(1)
      // Resolving once (from EITHER surface) resolves the single engine gate.
      expect(resolveActionGate('act_1', { kind: 'approve' })).toBe(true)
      await expect(parked).resolves.toEqual({ kind: 'approve' })
      expect(pendingActionGateCount()).toBe(0)
    } finally {
      unregister()
    }
  })
})

describe('parseGateDecision', () => {
  it('accepts the three decision shapes and nothing else', () => {
    expect(parseGateDecision({ kind: 'approve' })).toEqual({ kind: 'approve' })
    expect(parseGateDecision({ kind: 'reject', reason: 'no' })).toEqual({
      kind: 'reject',
      reason: 'no'
    })
    expect(parseGateDecision({ kind: 'reject', reason: 42 })).toEqual({ kind: 'reject' })
    expect(parseGateDecision({ kind: 'edit', args: { title: 'x' } })).toEqual({
      kind: 'edit',
      args: { title: 'x' }
    })
    expect(parseGateDecision({ kind: 'edit', args: [] })).toBeNull()
    expect(parseGateDecision({ kind: 'edit' })).toBeNull()
    expect(parseGateDecision({ kind: 'sudo' })).toBeNull()
    expect(parseGateDecision('approve')).toBeNull()
    expect(parseGateDecision(null)).toBeNull()
  })
})

describe('needsApproval (computer use AND sends are gated)', () => {
  it('gates the computer-use rails and send actions; everything else runs through', () => {
    expect(needsApproval({ rail: 'accessibility', type: 'computer' })).toBe(true)
    expect(needsApproval({ rail: 'vision', type: 'computer' })).toBe(true)
    // Sends are irreversible with no reliable read-back - always confirmed.
    expect(needsApproval({ rail: 'semantic', type: 'message' })).toBe(true)
    expect(needsApproval({ rail: 'semantic', type: 'email' })).toBe(true)
    // web_task acts in Off Grid's own watched pane - supervised, not gated.
    expect(needsApproval({ rail: 'browser', type: 'web' })).toBe(false)
    // Undoable mutations and reads run through (calendar/reminders auto-run + Undo).
    expect(needsApproval({ rail: 'semantic', type: 'calendar' })).toBe(false)
    expect(needsApproval({ rail: 'semantic', type: 'lookup' })).toBe(false)
    expect(needsApproval({ type: 'calendar' })).toBe(false)
  })

  it('gateHost auto-approves a browser (web_task) action even with a surface listening', async () => {
    const dispose = registerInlineGateSurface(() => {
      throw new Error('a web_task must NOT park for approval')
    })
    const decision = await gateHost({ action: record({ rail: 'browser' }) })
    expect(decision).toEqual({ kind: 'approve' })
    expect(pendingActionGateCount()).toBe(0)
    dispose()
  })
})

describe('send gating (mail_send / messages_send confirm every time)', () => {
  it('parks an email send for approval when a surface is listening', async () => {
    const seen: InlineGateRequest[] = []
    const dispose = registerInlineGateSurface((request) => void seen.push(request))
    const parked = gateHost({
      action: record({ rail: 'semantic', type: 'email', intent: 'email the deck to Sam' })
    })
    expect(pendingActionGateCount()).toBe(1)
    expect(seen[0]).toMatchObject({ actionType: 'email' })
    resolveActionGate('act_1', { kind: 'approve' })
    expect(await parked).toEqual({ kind: 'approve' })
    dispose()
  })

  it('the auto toggle covers computer use only - a send still parks in auto mode', async () => {
    const unregister = registerApprovalModeProvider(() => 'auto')
    const dispose = registerInlineGateSurface(() => {})
    try {
      const parked = gateHost({
        action: record({ rail: 'semantic', type: 'message', intent: 'text Sam' })
      })
      expect(pendingActionGateCount()).toBe(1) // parked despite auto mode
      resolveActionGate('act_1', { kind: 'reject' })
      expect(await parked).toMatchObject({ kind: 'reject' })
    } finally {
      dispose()
      unregister()
    }
  })
})

describe('computerApprovalMode (the Sync-sharing auto/ask setting)', () => {
  afterEach(() => {
    // Ensure no provider leaks into other tests (default must be 'ask').
    registerApprovalModeProvider(() => 'ask')()
  })

  it('defaults to ask when no provider is registered (free build / tests)', () => {
    expect(computerApprovalMode()).toBe('ask')
  })

  it('reads the registered provider, and unregister restores the ask default', () => {
    let mode: 'auto' | 'ask' = 'auto'
    const unregister = registerApprovalModeProvider(() => mode)
    expect(computerApprovalMode()).toBe('auto')
    mode = 'ask'
    expect(computerApprovalMode()).toBe('ask')
    unregister()
    expect(computerApprovalMode()).toBe('ask')
  })

  it('mode "auto" approves a computer-use gate without parking, even with a pro queue listening', async () => {
    const proSaw = vi.fn(() => true)
    registerHook(HOOKS.actionsProposeApproval, proSaw)
    const unregister = registerApprovalModeProvider(() => 'auto')
    try {
      const decision = await gateHost({ action: record({ rail: 'vision' }) })
      expect(decision).toEqual({ kind: 'approve' })
      expect(pendingActionGateCount()).toBe(0) // never parked
      expect(proSaw).not.toHaveBeenCalled() // auto short-circuits before the queue
    } finally {
      unregister()
    }
  })

  it('mode "ask" parks the gate for approval (the default path)', async () => {
    registerHook(HOOKS.actionsProposeApproval, () => true)
    const unregister = registerApprovalModeProvider(() => 'ask')
    try {
      const parked = gateHost({ action: record() })
      expect(pendingActionGateCount()).toBe(1)
      resolveActionGate('act_1', { kind: 'approve' })
      await expect(parked).resolves.toEqual({ kind: 'approve' })
    } finally {
      unregister()
    }
  })
})

describe('approvalBypassed (OFFGRID_AUTO_APPROVE testing escape hatch)', () => {
  afterEach(() => {
    delete process.env.OFFGRID_AUTO_APPROVE
  })

  it('is off by default', () => {
    delete process.env.OFFGRID_AUTO_APPROVE
    expect(approvalBypassed()).toBe(false)
  })

  it('approves every gated action immediately, without parking, when set', async () => {
    process.env.OFFGRID_AUTO_APPROVE = '1'
    expect(approvalBypassed()).toBe(true)
    const before = pendingActionGateCount()
    const decision = await gateHost({ action: record({ risk: 'irreversible' }) })
    expect(decision).toEqual({ kind: 'approve' })
    expect(pendingActionGateCount()).toBe(before) // never parked for a human
  })
})
