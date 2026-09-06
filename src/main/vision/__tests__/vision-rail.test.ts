/**
 * The vision rail's engine adapter: computer_use registers on the vision rail
 * as a no-retry mutation, and the executor maps a run's result to an
 * ExecuteResult. The host (the supervised session) is the injected boundary.
 */
import { describe, expect, it, vi } from 'vitest'
import { HandlerRegistry, type ActionRecord } from '@offgrid/use'
import { makeVisionRailExecutor, registerVisionRail, type VisionRailHost } from '../vision-rail'
import type { VisionTaskResult } from '../vision-agent'

const action = (args: Record<string, unknown>): ActionRecord =>
  ({
    id: 'act_vis',
    type: 'computer_use',
    intent: 'share the deck over WhatsApp',
    args,
    risk: 'mutate',
    rail: 'vision'
  }) as unknown as ActionRecord

const run = (over: Partial<VisionTaskResult> = {}): VisionTaskResult => ({
  ok: true,
  summary: 'sent',
  steps: [],
  handoffs: 0,
  ...over
})

describe('registerVisionRail', () => {
  it('registers computer_use on the vision rail, gating and never retrying', () => {
    const registry = new HandlerRegistry()
    registerVisionRail(registry)
    const handler = registry.get('computer_use')
    expect(handler?.rail).toBe('vision')
    expect(registry.route('computer_use')).toBe('vision')
    expect(handler?.verification).toBe('none_fuzzy')
    expect(handler?.verify).toBeUndefined()
    expect(handler?.defaultRisk).toBe('mutate')
  })
})

describe('makeVisionRailExecutor', () => {
  it('runs the task with the goal and returns the action id as the effect', async () => {
    const host: VisionRailHost = { runTask: vi.fn(async () => run()) }
    const result = await makeVisionRailExecutor(host)(action({ goal: 'share the deck' }))
    expect(host.runTask).toHaveBeenCalledWith('share the deck', 'act_vis', 'act_vis')
    expect(result).toEqual({ ok: true, effectId: 'act_vis' })
  })

  it('falls back to the action intent when no explicit goal is given', async () => {
    const host: VisionRailHost = { runTask: vi.fn(async () => run()) }
    await makeVisionRailExecutor(host)(action({}))
    expect(host.runTask).toHaveBeenCalledWith(
      'share the deck over WhatsApp',
      'act_vis',
      'act_vis'
    )
  })

  it('keeps the originating Chat as the task journey', async () => {
    const host: VisionRailHost = { runTask: vi.fn(async () => run()) }
    const originatingChat = { ...action({ goal: 'share the deck' }), sourceRef: 'chat-42' }

    await makeVisionRailExecutor(host)(originatingChat)

    expect(host.runTask).toHaveBeenCalledWith('share the deck', 'act_vis', 'chat-42')
  })

  it('surfaces a stopped or failed run as the honest failure', async () => {
    const host: VisionRailHost = {
      runTask: vi.fn(async () => run({ ok: false, summary: 'stopped with Esc' }))
    }
    const result = await makeVisionRailExecutor(host)(action({ goal: 'x' }))
    expect(result).toEqual({ ok: false, detail: 'stopped with Esc' })
  })
})
