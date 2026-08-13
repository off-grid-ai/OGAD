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
  pendingActionGateCount,
  railToKind,
  resolveActionGate
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
