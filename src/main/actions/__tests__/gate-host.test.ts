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
  approvalConversation,
  approvalBypassed,
  gateHost,
  needsApproval,
  onActionParked,
  onGateParked,
  parseGateDecision,
  pendingActionGateCount,
  railToKind,
  resolveActionGate,
  whenActionParked
} from '../gate-host'

const record = (overrides: Partial<ActionRecord> = {}): ActionRecord =>
  ({
    type: 'reminder',
    intent: 'remind me to send the deck',
    args: { title: 'Send the deck' },
    risk: 'mutate',
    id: 'act_1',
    source: 'chat',
    sourceRef: 'chat-1',
    payloadHash: 'a'.repeat(64),
    // Default to a Computer Use rail. Connector and visual rails use the source
    // policy; semantic actions use their own risk-specific path.
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
    expect(railToKind('connector')).toBe('mcp')
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
    const decision = await gateHost({
      action: record({ source: 'routine', sourceRef: undefined })
    })
    expect(decision).toEqual({ kind: 'approve' })
  })

  it('a non-chat queued action parks until Action Approval resolves it', async () => {
    const seen = vi.fn(() => true)
    registerHook(HOOKS.actionsProposeApproval, seen)

    const parked = gateHost({ action: record({ source: 'routine', sourceRef: undefined }) })
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
    const parked = gateHost({
      action: record({
        rail: 'vision',
        risk: 'irreversible',
        source: 'routine',
        sourceRef: undefined
      })
    })
    expect(request).toMatchObject({
      kind: 'computer',
      risk: 'irreversible',
      actionId: 'act_1',
      actionType: 'reminder',
      payloadHash: 'a'.repeat(64),
      title: 'remind me to send the deck',
      args: { title: 'Send the deck' },
      source: 'routine'
    })
    resolveActionGate('act_1', { kind: 'reject', reason: 'no' })
    await expect(parked).resolves.toEqual({ kind: 'reject', reason: 'no' })
  })

  it('reject and edit decisions pass through untouched', async () => {
    registerHook(HOOKS.actionsProposeApproval, () => true)
    const first = gateHost({ action: record({ source: 'routine', sourceRef: undefined }) })
    resolveActionGate('act_1', { kind: 'edit', args: { title: 'Send the v2 deck' } })
    await expect(first).resolves.toEqual({ kind: 'edit', args: { title: 'Send the v2 deck' } })
  })

  it('resolving an unknown action reports false instead of throwing', () => {
    expect(resolveActionGate('act_ghost', { kind: 'approve' })).toBe(false)
  })

  it('falls back to the legacy mcp hook when the new one is unregistered', async () => {
    const legacy = vi.fn(() => true)
    registerHook(HOOKS.legacyMcpProposeApproval, legacy)
    const parked = gateHost({ action: record({ source: 'routine', sourceRef: undefined }) })
    expect(legacy).toHaveBeenCalled()
    resolveActionGate('act_1', { kind: 'approve' })
    await parked
  })
})

describe('the park signals', () => {
  it('whenActionParked resolves immediately for an already-parked action', async () => {
    registerHook(HOOKS.actionsProposeApproval, () => true)
    const parked = gateHost({ action: record({ source: 'routine', sourceRef: undefined }) })
    await whenActionParked('act_1') // already pending: resolves now
    resolveActionGate('act_1', { kind: 'approve' })
    await parked
  })

  it('whenActionParked resolves when the park happens later', async () => {
    registerHook(HOOKS.actionsProposeApproval, () => true)
    const waiting = whenActionParked('act_1')
    const parked = gateHost({ action: record({ source: 'routine', sourceRef: undefined }) })
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
    const first = gateHost({ action: record({ source: 'routine', sourceRef: undefined }) })
    expect(fired).toBe(1)
    resolveActionGate('act_1', { kind: 'approve' })
    await first

    unsubscribe()
    const second = gateHost({
      action: record({ id: 'act_2', source: 'routine', sourceRef: undefined })
    })
    expect(fired).toBe(1)
    resolveActionGate('act_2', { kind: 'approve' })
    await second
  })

  it('a cancelled action-specific parked observer does not fire', async () => {
    registerHook(HOOKS.actionsProposeApproval, () => true)
    const listener = vi.fn()
    const unsubscribe = onActionParked('act_1', listener)
    unsubscribe()
    const parked = gateHost({ action: record({ source: 'routine', sourceRef: undefined }) })
    expect(listener).not.toHaveBeenCalled()
    resolveActionGate('act_1', { kind: 'approve' })
    await parked
  })

  it('pendingActionGateCount tracks parks and abandonActionGate drops one', () => {
    registerHook(HOOKS.actionsProposeApproval, () => true)
    void gateHost({ action: record({ source: 'routine', sourceRef: undefined }) })
    expect(pendingActionGateCount()).toBe(1)
    expect(abandonActionGate('act_1')).toBe(true)
    expect(abandonActionGate('act_1')).toBe(false)
    expect(pendingActionGateCount()).toBe(0)
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

describe('needsApproval', () => {
  it('gates connector and task rails and leaves semantic actions to their own policy', () => {
    expect(needsApproval(record({ rail: 'connector' }))).toBe(true)
    expect(needsApproval(record({ rail: 'accessibility' }))).toBe(true)
    expect(needsApproval(record({ rail: 'vision' }))).toBe(true)
    expect(needsApproval(record({ rail: 'browser' }))).toBe(true)
    expect(needsApproval(record({ rail: 'semantic' }))).toBe(false)
    expect(needsApproval(record({ rail: undefined }))).toBe(false)
  })

  it('starts a Chat-owned browser task without proposing an approval', async () => {
    const proSaw = vi.fn(() => true)
    registerHook(HOOKS.actionsProposeApproval, proSaw)
    const decision = await gateHost({ action: record({ rail: 'browser', type: 'web_use' }) })
    expect(proSaw).not.toHaveBeenCalled()
    expect(decision).toEqual({ kind: 'approve' })
    expect(pendingActionGateCount()).toBe(0)
  })

  it('starts a Chat-owned connector action without proposing an approval', async () => {
    const proSaw = vi.fn(() => true)
    registerHook(HOOKS.actionsProposeApproval, proSaw)
    const decision = await gateHost({
      action: record({ rail: 'connector', type: 'connector' })
    })
    expect(proSaw).not.toHaveBeenCalled()
    expect(decision).toEqual({ kind: 'approve' })
    expect(pendingActionGateCount()).toBe(0)
  })
})

describe('approvalConversation', () => {
  it('uses only a valid Chat sourceRef as the inline approval owner', () => {
    expect(approvalConversation(record())).toBe('chat-1')
    expect(approvalConversation(record({ source: 'routine' }))).toBeNull()
    expect(approvalConversation(record({ sourceRef: '  ' }))).toBeNull()
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
