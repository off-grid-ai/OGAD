/**
 * computer_use tiering: a control-rich AX window drives via accessibility; a
 * dead-AX window (or a goal that names no running app) falls through to vision.
 * The routing decision is made once, from the snapshot - AX failure is reported
 * honestly, never silently re-run under vision.
 */
import { describe, expect, it, vi } from 'vitest'
import { makeComputerTaskExecutor, type ComputerTaskTiers } from '../ax-rail'
import { MIN_ACTIONABLE_ELEMENTS } from '../ax-router'
import type { AxElement, AxSnapshot } from '../ax-elements'
import type { AxRouting } from '../ax-host'
import type { ElementTaskResult } from '../ax-agent'
import type { ActionRecord, ExecuteResult } from '@offgrid/use'

const el = (over: Partial<AxElement> = {}): AxElement => ({
  index: 1,
  role: 'AXButton',
  name: 'x',
  value: '',
  cx: 0,
  cy: 0,
  actionable: true,
  enabled: true,
  ...over
})

const richSnapshot = (): AxSnapshot => ({
  windowTitle: 'Slack',
  elements: Array.from({ length: MIN_ACTIONABLE_ELEMENTS }, () => el())
})

const deadSnapshot = (): AxSnapshot => ({
  windowTitle: 'Game',
  elements: [el({ role: 'AXStaticText', actionable: false })]
})

const action = (over: Partial<ActionRecord> = {}): ActionRecord =>
  ({
    id: 'act-1',
    intent: 'message sidd on Slack',
    args: {},
    ...over
  }) as ActionRecord

function makeTiers(over: Partial<ComputerTaskTiers>): ComputerTaskTiers {
  return {
    routingSnapshot: vi.fn(async () => null),
    runAx: vi.fn(async () => ({ ok: true, summary: 'done', steps: [] }) as ElementTaskResult),
    visionExecute: vi.fn(async () => ({ ok: true, effectId: 'vision' }) as ExecuteResult),
    ...over
  }
}

describe('makeComputerTaskExecutor', () => {
  it('drives via accessibility when the AX tree is rich', async () => {
    const routing: AxRouting = { app: 'Slack', snapshot: richSnapshot() }
    const tiers = makeTiers({ routingSnapshot: vi.fn(async () => routing) })
    const exec = makeComputerTaskExecutor(tiers, { enabledRails: ['ax', 'vision'] })

    const result = await exec(action())

    expect(tiers.runAx).toHaveBeenCalledWith(
      'message sidd on Slack',
      'act-1',
      'act-1',
      'Slack',
      expect.objectContaining({
        initial: routing.snapshot,
        recoverWithVision: expect.any(Function)
      })
    )
    expect(tiers.visionExecute).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, effectId: 'act-1' })
  })

  it('reports an AX give_up honestly and does NOT fall to vision', async () => {
    const routing: AxRouting = { app: 'Slack', snapshot: richSnapshot() }
    const tiers = makeTiers({
      routingSnapshot: vi.fn(async () => routing),
      runAx: vi.fn(async () => ({ ok: false, summary: 'needs a sign-in', steps: [] }))
    })
    const exec = makeComputerTaskExecutor(tiers, { enabledRails: ['ax', 'vision'] })

    const result = await exec(action())

    expect(result).toEqual({ ok: false, detail: 'needs a sign-in' })
    expect(tiers.visionExecute).not.toHaveBeenCalled()
  })

  it('falls through to vision on a dead-AX window', async () => {
    const routing: AxRouting = { app: 'Game', snapshot: deadSnapshot() }
    const tiers = makeTiers({ routingSnapshot: vi.fn(async () => routing) })
    const exec = makeComputerTaskExecutor(tiers, { enabledRails: ['ax', 'vision'] })

    const result = await exec(action({ intent: 'play the game' }))

    expect(tiers.runAx).not.toHaveBeenCalled()
    expect(tiers.visionExecute).toHaveBeenCalledOnce()
    expect(result).toEqual({ ok: true, effectId: 'vision' })
  })

  it('falls through to vision when the goal names no running app', async () => {
    const tiers = makeTiers({ routingSnapshot: vi.fn(async () => null) })
    const exec = makeComputerTaskExecutor(tiers, { enabledRails: ['ax', 'vision'] })

    const result = await exec(action({ intent: 'do something vague' }))

    expect(tiers.runAx).not.toHaveBeenCalled()
    expect(tiers.visionExecute).toHaveBeenCalledOnce()
    expect(result).toEqual({ ok: true, effectId: 'vision' })
  })

  it('prefers an explicit args.goal over the intent', async () => {
    const routing: AxRouting = { app: 'Slack', snapshot: richSnapshot() }
    const routingSnapshot = vi.fn(async () => routing)
    const tiers = makeTiers({ routingSnapshot })
    const exec = makeComputerTaskExecutor(tiers, { enabledRails: ['ax', 'vision'] })

    await exec(action({ args: { goal: 'open the DM with sidd' } }))

    expect(routingSnapshot).toHaveBeenCalledWith('open the DM with sidd')
  })

  it('keeps the originating Chat as the AX task journey', async () => {
    const routing: AxRouting = { app: 'Slack', snapshot: richSnapshot() }
    const tiers = makeTiers({ routingSnapshot: vi.fn(async () => routing) })
    const exec = makeComputerTaskExecutor(tiers, { enabledRails: ['ax', 'vision'] })

    await exec(action({ sourceRef: 'chat-42' }))

    expect(tiers.runAx).toHaveBeenCalledWith(
      'message sidd on Slack',
      'act-1',
      'chat-42',
      'Slack',
      expect.objectContaining({
        initial: routing.snapshot,
        recoverWithVision: expect.any(Function)
      })
    )
  })

  describe('forced rail (A/B)', () => {
    it("forcedRail 'vision' resolves the target app without running AX and uses the grounder", async () => {
      const routingSnapshot = vi.fn(async () => ({ app: 'Slack', snapshot: richSnapshot() }))
      const tiers = makeTiers({ routingSnapshot })
      const exec = makeComputerTaskExecutor(tiers, { forcedRail: 'vision' })

      const result = await exec(action())

      expect(routingSnapshot).toHaveBeenCalledWith('message sidd on Slack')
      expect(tiers.runAx).not.toHaveBeenCalled()
      expect(tiers.visionExecute).toHaveBeenCalledOnce()
      expect(result).toEqual({ ok: true, effectId: 'vision' })
    })

    it("forcedRail 'ax' drives via AX even on a dead-AX window (as long as an app resolved)", async () => {
      const routing: AxRouting = { app: 'Game', snapshot: deadSnapshot() }
      const tiers = makeTiers({ routingSnapshot: vi.fn(async () => routing) })
      const exec = makeComputerTaskExecutor(tiers, { forcedRail: 'ax' })

      const result = await exec(action({ intent: 'play the game' }))

      expect(tiers.runAx).toHaveBeenCalledOnce() // forced past the viability gate
      expect(tiers.visionExecute).not.toHaveBeenCalled()
      expect(result).toEqual({ ok: true, effectId: 'act-1' })
    })

    it("forcedRail 'ax' fails when no app resolves instead of using vision", async () => {
      const tiers = makeTiers({ routingSnapshot: vi.fn(async () => null) })
      const exec = makeComputerTaskExecutor(tiers, { forcedRail: 'ax' })

      const result = await exec(action())

      expect(tiers.runAx).not.toHaveBeenCalled()
      expect(tiers.visionExecute).not.toHaveBeenCalled()
      expect(result).toEqual({
        ok: false,
        detail: 'The Accessibility rail could not find a target app.'
      })
    })
  })
})

describe('parseForcedRail', () => {
  it('accepts ax/vision and defaults everything else to auto', async () => {
    const { parseForcedRail } = await import('../ax-rail')
    expect(parseForcedRail('ax')).toBe('ax')
    expect(parseForcedRail('vision')).toBe('vision')
    expect(parseForcedRail('auto')).toBe('auto')
    expect(parseForcedRail(undefined)).toBe('auto')
    expect(parseForcedRail('nonsense')).toBe('auto')
  })
})
