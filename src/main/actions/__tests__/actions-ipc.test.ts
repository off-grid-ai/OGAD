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
      { webContents: { send: (channel: string, payload: unknown) => world.sent.push({ channel, payload }) } }
    ]
  }
}))

vi.mock('../use-runtime', () => ({
  getActionsRuntime: () => ({
    onOutcome: (listener: (event: unknown) => void) => {
      world.outcomeListener = listener
      return () => {}
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
    registerActionsIpc()
  })

  it('a parked gate broadcasts the card request, and resolve-gate resolves it', async () => {
    const parked = gateHost({ action: record() })
    const pendingEvent = world.sent.find((s) => s.channel === 'actions:gate-pending')
    expect(pendingEvent?.payload).toMatchObject({ actionId: 'act_ipc', risk: 'irreversible' })

    const resolveHandler = world.handlers.get('actions:resolve-gate')
    expect(await resolveHandler?.({}, 'act_ipc', { kind: 'approve' })).toBe(true)
    await expect(parked).resolves.toEqual({ kind: 'approve' })
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
