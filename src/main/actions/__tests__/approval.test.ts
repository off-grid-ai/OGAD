/**
 * Unit tests for the transport-agnostic action-approval seam. High blast radius:
 * every executor that can act on the user's behalf (MCP connectors today, computer
 * and browser actions next) gates through shouldGate + proposeActionApproval, and
 * the free/pro split hinges on whether a hook is registered.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  shouldGate,
  proposeActionApproval,
  type ActionApprovalRequest,
  type ActionRisk
} from '../approval'
import { registerHook, unregisterHook, HOOKS } from '../../bootstrap/hookRegistry'

const NEW = HOOKS.actionsProposeApproval
const LEGACY = HOOKS.legacyMcpProposeApproval

function request(risk: ActionRisk): ActionApprovalRequest {
  return { kind: 'mcp', title: 't', detail: 'd', risk, args: {}, source: 'chat' }
}

afterEach(() => {
  unregisterHook(NEW)
  unregisterHook(LEGACY)
})

describe('shouldGate', () => {
  it('gates mutate and irreversible, runs read and navigate freely', () => {
    expect(shouldGate('mutate')).toBe(true)
    expect(shouldGate('irreversible')).toBe(true)
    expect(shouldGate('read')).toBe(false)
    expect(shouldGate('navigate')).toBe(false)
  })
})

describe('proposeActionApproval', () => {
  it('returns undefined when nothing is listening (free build runs the action)', () => {
    expect(proposeActionApproval(request('mutate'))).toBeUndefined()
  })

  it('routes to the new hook and forwards its verdict', () => {
    registerHook(NEW, () => true)
    expect(proposeActionApproval(request('mutate'))).toBe(true)
  })

  it('honours a registered new hook that declined to queue (returns false)', () => {
    registerHook(NEW, () => false)
    expect(proposeActionApproval(request('mutate'))).toBe(false)
  })

  it('trusts a registered new hook even when it returns undefined — no legacy fallback', () => {
    let legacyCalled = false
    registerHook(NEW, () => undefined)
    registerHook(LEGACY, () => {
      legacyCalled = true
      return true
    })
    expect(proposeActionApproval(request('mutate'))).toBeUndefined()
    expect(legacyCalled).toBe(false)
  })

  it('falls back to the legacy hook when the new name is unregistered', () => {
    registerHook(LEGACY, () => true)
    expect(proposeActionApproval(request('mutate'))).toBe(true)
  })

  it('passes the full request through to the handler', () => {
    let seen: ActionApprovalRequest | undefined
    registerHook(NEW, (req: ActionApprovalRequest) => {
      seen = req
      return true
    })
    const req = request('irreversible')
    proposeActionApproval(req)
    expect(seen).toEqual(req)
  })
})
