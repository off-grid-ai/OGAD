/**
 * The actions IPC contract: channel names, fail-closed argument parsing, and
 * the broadcast fanout. Electron and the runtime are the mocked boundaries
 * (the runtime's behaviour is proven in its own dbtest); what this locks is
 * the wiring the renderer depends on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const world = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  sent: [] as Array<{ channel: string; payload: unknown }>,
  outcomeListener: undefined as undefined | ((event: unknown) => void),
  projectionListener: undefined as undefined | ((snapshot: unknown) => void),
  projectionStops: 0,
  outcomeStops: 0,
  retryCalls: [] as string[],
  undoCalls: [] as unknown[]
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      world.handlers.set(channel, handler)
    }
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel: string, payload: unknown) => world.sent.push({ channel, payload })
        }
      }
    ]
  }
}))

vi.mock('../use-runtime', () => ({
  getActionsRuntime: () => ({
    snapshot: () => ({ actions: [], active: [], running: false }),
    subscribe: (listener: (snapshot: unknown) => void) => {
      world.projectionListener = listener
      return () => {
        world.projectionStops += 1
      }
    },
    onOutcome: (listener: (event: unknown) => void) => {
      world.outcomeListener = listener
      return () => {
        world.outcomeStops += 1
      }
    },
    retry: async (actionId: string) => {
      world.retryCalls.push(actionId)
      return { ok: true, value: true }
    },
    undo: async (record: unknown) => {
      world.undoCalls.push(record)
      return { ok: true }
    }
  })
}))

import { registerActionsIpc } from '../actions-ipc'
import { gateHost } from '../gate-host'
import { computePayloadHash, type ActionRecord } from '@offgrid/use'

const record = (): ActionRecord => {
  const payload = { type: 'message', intent: 'text Ali', args: { text: 'hi' } }
  return {
    ...payload,
    risk: 'irreversible',
    id: 'act_ipc',
    source: 'chat',
    sourceRef: 'conversation-ipc',
    payloadHash: computePayloadHash({ ...payload, triggerAt: undefined }),
    // Only computer-use gates now, so this parked-gate test uses that rail.
    rail: 'accessibility',
    idempotencyKey: 'k',
    attempts: 0,
    attemptLog: [],
    state: 'awaiting_approval',
    createdAt: 1,
    updatedAt: 1
  } as ActionRecord
}

describe('registerActionsIpc', () => {
  beforeEach(() => {
    world.handlers.clear()
    world.sent.length = 0
    world.undoCalls.length = 0
    world.retryCalls.length = 0
    world.projectionStops = 0
    world.outcomeStops = 0
    registerActionsIpc()
  })

  it('starts a Chat task directly without an approval broadcast', async () => {
    await expect(gateHost({ action: record() })).resolves.toEqual({ kind: 'approve' })
    expect(world.sent.some((event) => event.channel === 'actions:gate-pending')).toBe(false)
  })

  it('resolve-gate fails closed on junk decisions and ids', async () => {
    const handler = world.handlers.get('actions:resolve-gate')
    expect(await handler?.({}, 42, { kind: 'approve' })).toBe(false)
    expect(await handler?.({}, 'act_x', { kind: 'sudo' })).toBe(false)
    expect(await handler?.({}, 'act_ghost', { kind: 'approve' })).toBe(false)
  })

  it('outcomes broadcast with undoability attached', () => {
    world.outcomeListener?.({
      outcome: { id: 'act_1', outcome: 'done', record: record() },
      undoable: true
    })
    const event = world.sent.find((s) => s.channel === 'actions:outcome')
    expect(event?.payload).toMatchObject({ id: 'act_1', outcome: 'done', undoable: true })
  })

  it('transports the canonical projection and retry intent without mapping them', async () => {
    const getProjection = world.handlers.get('actions:get-projection')
    expect(getProjection?.({})).toEqual({ actions: [], active: [], running: false })

    const projection = { actions: [record()], active: [record()], running: true }
    world.projectionListener?.(projection)
    expect(
      world.sent.find((event) => event.channel === 'actions:projection-changed')?.payload
    ).toBe(projection)

    const retry = world.handlers.get('actions:retry')
    await expect(retry?.({}, 'act_ipc')).resolves.toEqual({ ok: true, value: true })
    expect(world.retryCalls).toEqual(['act_ipc'])
  })

  it('releases both Shared subscriptions during application shutdown', () => {
    const release = registerActionsIpc()
    release()
    expect(world.projectionStops).toBe(1)
    expect(world.outcomeStops).toBe(1)
  })

  it('undo revalidates the record and refuses junk', async () => {
    const handler = world.handlers.get('actions:undo')
    const refused = (await handler?.({}, { not: 'a record' })) as { ok: boolean }
    expect(refused.ok).toBe(false)
    expect(world.undoCalls).toHaveLength(0)
    const accepted = (await handler?.({}, record())) as { ok: boolean }
    expect(accepted.ok).toBe(true)
    expect(world.undoCalls).toHaveLength(1)
  })
})
