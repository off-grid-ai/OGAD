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
  gateHost,
  onGateParked,
  parseGateDecision,
  pendingActionGateCount,
  railToKind,
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
    rail: 'semantic',
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
    const parked = gateHost({ action: record({ rail: 'browser', risk: 'irreversible' }) })
    expect(request).toMatchObject({
      kind: 'browser',
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
      const parked = gateHost({ action: record({ risk: 'irreversible', rail: 'semantic' }) })
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        actionId: 'act_1',
        actionType: 'reminder',
        kind: 'native',
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

  it('a listening pro queue still wins over the inline surface (until the migration)', async () => {
    const requests: unknown[] = []
    const unregister = registerInlineGateSurface((request) => requests.push(request))
    try {
      registerHook(HOOKS.actionsProposeApproval, () => true)
      const parked = gateHost({ action: record() })
      expect(requests).toHaveLength(0)
      resolveActionGate('act_1', { kind: 'approve' })
      await parked
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
