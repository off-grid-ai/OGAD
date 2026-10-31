/**
 * The actions IPC contract: channel names, fail-closed argument parsing, and the broadcast fanout,
 * over the real actions runtime. Electron and the native actions helper (an executable that keeps
 * reminders, harness/fake-actions-helper) are the boundaries.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeActionsHelper } from '../../__tests__/harness/fake-actions-helper'

const world = vi.hoisted(() => ({
  profile: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  sent: [] as Array<{ channel: string; payload: unknown }>
}))
world.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-actions-ipc-'))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => world.profile, getAppPath: () => world.profile },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: async () => {} },
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

const helper = installFakeActionsHelper(world.profile)
const previousDataDir = process.env.OFFGRID_DATA_DIR
let restoreCwd: () => void = () => {}
beforeAll(() => {
  process.env.OFFGRID_DATA_DIR = world.profile
  restoreCwd = helper.useFrom()
})
afterAll(() => {
  restoreCwd()
  if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDataDir
  fs.rmSync(world.profile, { recursive: true, force: true })
})

import { registerActionsIpc } from '../actions-ipc'
import { getActionsRuntime } from '../use-runtime'
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
    // The runtime composes as on a Mac, where reminders run through the native helper.
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
      registerActionsIpc()
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
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

  /** A reminder the runtime really runs: it lands in the helper and its outcome is broadcast. */
  const remind = async (title: string): Promise<ActionRecord> => {
    const runtime = getActionsRuntime()
    const proposed = await runtime.propose(
      { type: 'reminder', intent: `remind me to ${title}`, args: { title }, risk: 'mutate' },
      { source: 'chat' }
    )
    if (!proposed.accepted) throw new Error('reminder refused')
    runtime.kick()
    const outcome = await runtime.waitForOutcome(proposed.id, 10_000)
    if (outcome?.outcome !== 'done') throw new Error(`reminder ${outcome?.outcome ?? 'timed out'}`)
    return outcome.record
  }

  it('outcomes broadcast with undoability attached', async () => {
    const done = await remind('send the deck')
    const event = world.sent.find((s) => s.channel === 'actions:outcome')
    expect(event?.payload).toMatchObject({ id: done.id, outcome: 'done', undoable: true })
  })

  it('undo revalidates the record and refuses junk', async () => {
    const done = await remind('call the bank')
    const before = helper.landed().length
    const handler = world.handlers.get('actions:undo')
    const refused = (await handler?.({}, { not: 'a record' })) as { ok: boolean }
    expect(refused.ok).toBe(false)
    expect(helper.landed()).toHaveLength(before)
    const accepted = (await handler?.({}, done)) as { ok: boolean }
    expect(accepted.ok).toBe(true)
    expect(helper.landed().map(({ title }) => title)).not.toContain('call the bank')
  })
})
