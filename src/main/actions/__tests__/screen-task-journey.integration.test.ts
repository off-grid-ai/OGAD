/**
 * Journey D3 - Run a screen task on the chosen server (shared/docs/FLOW_CONTRACT_DESKTOP.md).
 *
 * One test per contract line that a person can see when they RUN a screen task. The real screen
 * gate and the real privacy rules decide every outcome here; only the two facts the gate reads -
 * which server is chosen, and which model strategy is set - are supplied, exactly as the settings
 * a person already saved would supply them.
 *
 * Lines about the settings screen itself (D3.1 to D3.5, D3.7, D3.8, D3.12, D3.14) live with the
 * remote server settings screen and are not covered by this file.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ActionRecord } from '@offgrid/use'
import { withRemoteScreenGate } from '../remote-screen-gate'
import { currentRemoteScreenTaskSession } from '../remote-screen-session'

const action = { id: 'screen-task-1' } as ActionRecord

const server = (overrides: Record<string, unknown> = {}) => ({
  id: 'server-2',
  name: 'Second Server',
  provider: 'custom' as const,
  endpoint: 'https://second.example/v1',
  model: 'vision-model',
  screenFramesAllowed: true,
  apiKey: 'secret',
  ...overrides
})

/** The person's saved choice, read fresh on every run exactly as the app reads it. */
const gateFor = (chosen: ReturnType<typeof server> | null, execute: () => Promise<{ ok: true; effectId: string }>) =>
  withRemoteScreenGate('computer_use', execute, {
    modelStrategy: () => 'same_as_chat',
    activeServer: () => chosen
  })

describe('Journey D3 - run a screen task on the chosen server', () => {
  it('D3.6 - the run goes to the chosen server and comes back with a result', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, effectId: 'done' }))

    await expect(gateFor(server(), execute)(action)).resolves.toEqual({
      ok: true,
      effectId: 'done'
    })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('D3.7 - the run touches only the chosen server, never the other one', async () => {
    const seen: unknown[] = []
    const execute = vi.fn(async () => {
      seen.push(currentRemoteScreenTaskSession()?.activeServer?.name)
      return { ok: true as const, effectId: 'done' }
    })

    await gateFor(server(), execute)(action)

    expect(seen).toEqual(['Second Server'])
    expect(seen).not.toContain('First Server')
  })

  it('D3.8 - a second run without changing anything still names the chosen server', async () => {
    const seen: unknown[] = []
    const execute = vi.fn(async () => {
      seen.push(currentRemoteScreenTaskSession()?.activeServer?.name)
      return { ok: true as const, effectId: 'done' }
    })
    const chosen = server()
    const guarded = withRemoteScreenGate('computer_use', execute, {
      modelStrategy: () => 'same_as_chat',
      activeServer: () => chosen
    })

    await guarded(action)
    await guarded(action)

    expect(seen).toEqual(['Second Server', 'Second Server'])
  })

  it('D3.16 - every run reads the chosen server again, so a change is never missed', async () => {
    const seen: unknown[] = []
    const execute = vi.fn(async () => {
      seen.push(currentRemoteScreenTaskSession()?.activeServer?.name)
      return { ok: true as const, effectId: 'done' }
    })
    let chosen = server()
    const guarded = withRemoteScreenGate('computer_use', execute, {
      modelStrategy: () => 'same_as_chat',
      activeServer: () => chosen
    })

    await guarded(action)
    chosen = server({ id: 'server-3', name: 'Third Server' })
    await guarded(action)

    expect(seen).toEqual(['Second Server', 'Third Server'])
  })

  it('D3.9 - a chosen server that is switched off refuses the task and names it', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, effectId: 'done' }))

    // The person really arrives here: they chose Second Server, then turned it off. The saved
    // choice still points at it, so the run can and must name the server that is off. Passing no
    // server at all would be a different line (D3.13), and could never name anything.
    const result = await gateFor(server({ enabled: false }), execute)(action)

    expect(result).toMatchObject({ ok: false })
    expect((result as { detail?: string }).detail ?? '').toContain('Second Server')
    expect(execute).not.toHaveBeenCalled()
  })

  it('D3.10 - a refusal says plainly that no screen picture was sent', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, effectId: 'done' }))

    const result = await gateFor(server({ screenFramesAllowed: false }), execute)(action)

    expect(result).toMatchObject({ ok: false })
    expect((result as { detail?: string }).detail ?? '').toContain('did not send your screen')
    expect(execute).not.toHaveBeenCalled()
  })

  it('D3.11 - allowing the chosen server again lets the next run through, with no restart', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, effectId: 'done' }))
    let chosen = server({ screenFramesAllowed: false })
    const guarded = withRemoteScreenGate('computer_use', execute, {
      modelStrategy: () => 'same_as_chat',
      activeServer: () => chosen
    })

    await expect(guarded(action)).resolves.toMatchObject({ ok: false })
    chosen = server({ screenFramesAllowed: true })

    await expect(guarded(action)).resolves.toEqual({ ok: true, effectId: 'done' })
  })

  it('D3.13 - a run with no server chosen refuses and asks the person to choose one', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, effectId: 'done' }))

    const result = await gateFor(null, execute)(action)

    expect(result).toMatchObject({ ok: false })
    expect((result as { detail?: string }).detail ?? '').toMatch(/choose|select/i)
    expect(execute).not.toHaveBeenCalled()
  })

  it('D3.15 - a later run uses the same chosen server, with no second choice asked for', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, effectId: 'done' }))
    const chosen = server()
    const guarded = withRemoteScreenGate('computer_use', execute, {
      modelStrategy: () => 'same_as_chat',
      activeServer: () => chosen
    })

    await expect(guarded(action)).resolves.toEqual({ ok: true, effectId: 'done' })
    await expect(guarded(action)).resolves.toEqual({ ok: true, effectId: 'done' })
    expect(execute).toHaveBeenCalledTimes(2)
  })
})
