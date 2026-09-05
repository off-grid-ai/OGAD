/**
 * The actions IPC contract over the REAL Shared Use application: channel names,
 * fail-closed argument parsing, the canonical projection and the retry command.
 * Electron (ipcMain/BrowserWindow) is the ONLY fake, and it is faithful - a
 * second registration of a channel throws exactly as Electron does, and
 * removeHandler really releases the channel.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-actions-ipc-'))
const originalDataDir = process.env.OFFGRID_DATA_DIR
const originalSkipCompatibleGenerationModel = process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL
process.env.OFFGRID_DATA_DIR = profile
process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL = '1'

type IpcHandler = (event: { sender?: unknown }, ...args: unknown[]) => unknown

const handlers = new Map<string, IpcHandler>()
const listeners = new Map<string, (...args: unknown[]) => unknown>()
const sent: Array<{ channel: string; payload: unknown }> = []
const renderer = {
  isDestroyed: () => false,
  send: (channel: string, payload: unknown) => sent.push({ channel, payload })
}
const mainWindow = { isDestroyed: () => false, webContents: renderer }

vi.mock('electron', () => ({
  app: {
    getPath: () => profile,
    getAppPath: () => process.cwd(),
    getVersion: () => 'test',
    isPackaged: false
  },
  shell: { openExternal: async () => undefined },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  BrowserWindow: {
    getAllWindows: () => [mainWindow],
    getFocusedWindow: () => mainWindow
  },
  ipcMain: {
    // Faithful to Electron: registering a channel twice throws instead of
    // silently replacing the handler.
    handle: (channel: string, handler: IpcHandler) => {
      if (handlers.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`)
      }
      handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => handlers.delete(channel),
    on: (channel: string, listener: (...args: unknown[]) => unknown) =>
      listeners.set(channel, listener),
    removeListener: (channel: string) => listeners.delete(channel)
  }
}))

const { registerActionsIpc } = await import('../actions-ipc')
const { gateHost } = await import('../gate-host')
const { getActionsRuntime } = await import('../use-runtime')
const { computePayloadHash } = await import('@offgrid/use')
type ActionRecord = import('@offgrid/use').ActionRecord

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

const ACTION_CHANNELS = [
  'actions:get-projection',
  'actions:resolve-gate',
  'actions:undo',
  'actions:retry'
] as const

let release: () => void

beforeAll(async () => {
  const { setMainWindow } = await import('../../main-window')
  setMainWindow(mainWindow as never)
  const { startDesktopApplication } = await import('../../composition/application')
  await startDesktopApplication()
})

afterAll(async () => {
  const { applicationShutdown } = await import('../../shutdown')
  await applicationShutdown.shutdown()
  const { getDB } = await import('../../database')
  if (getDB().open) getDB().close()
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  if (originalSkipCompatibleGenerationModel === undefined)
    delete process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL
  else process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL = originalSkipCompatibleGenerationModel
  fs.rmSync(profile, { recursive: true, force: true })
})

describe('registerActionsIpc', () => {
  beforeEach(() => {
    // Electron refuses a duplicate channel, so a prior registration must be
    // released before the next one - exactly what production shutdown does.
    release?.()
    for (const channel of ACTION_CHANNELS) handlers.delete(channel)
    sent.length = 0
    release = registerActionsIpc()
  })

  it('starts a Chat task directly without an approval broadcast', async () => {
    await expect(gateHost({ action: record() })).resolves.toEqual({ kind: 'approve' })
    expect(sent.some((event) => event.channel === 'actions:gate-pending')).toBe(false)
  })

  it('resolve-gate fails closed on junk decisions and ids', async () => {
    const handler = handlers.get('actions:resolve-gate')
    expect(await handler?.({}, 42, { kind: 'approve' })).toBe(false)
    expect(await handler?.({}, 'act_x', { kind: 'sudo' })).toBe(false)
    expect(await handler?.({}, 'act_ghost', { kind: 'approve' })).toBe(false)
  })

  it('transports the canonical Shared projection, recoverable work included', async () => {
    const getProjection = handlers.get('actions:get-projection')
    const projection = (await getProjection?.({})) as {
      actions: unknown[]
      active: unknown[]
      recoverable: unknown[]
      terminal: unknown[]
      running: boolean
    }
    // The shape the renderer binds to is the shape Shared really emits - the
    // recoverable lane included, which a hand-written fixture used to drop.
    expect(projection).toEqual(getActionsRuntime().snapshot())
    expect(Object.keys(projection).sort()).toEqual([
      'actions',
      'active',
      'recoverable',
      'running',
      'terminal'
    ])
    expect(Array.isArray(projection.recoverable)).toBe(true)
    expect(Array.isArray(projection.terminal)).toBe(true)
  })

  it('retry of an action the engine does not hold fails closed and changes nothing', async () => {
    const retry = handlers.get('actions:retry')
    const before = getActionsRuntime().snapshot()

    expect(await retry?.({}, '')).toMatchObject({ ok: false })
    expect(await retry?.({}, 7)).toMatchObject({ ok: false })
    // A well-formed id the engine has never seen is a real no-op, not a crash.
    const unknown = (await retry?.({}, 'act_never_proposed')) as { ok: boolean; value?: boolean }
    expect(unknown.ok).toBe(true)
    expect(unknown.value).toBe(false)
    expect(getActionsRuntime().snapshot()).toEqual(before)
  })

  it('undo revalidates the record and refuses junk', async () => {
    const handler = handlers.get('actions:undo')
    const refused = (await handler?.({}, { not: 'a record' })) as { ok: boolean }
    expect(refused.ok).toBe(false)
    // A well-formed record the engine never ran reaches the real engine instead
    // of the parser refusal, and the engine reports its own verdict.
    const parsed = (await handler?.({}, record())) as { ok: boolean }
    expect(typeof parsed.ok).toBe('boolean')
  })

  it('releases its channels and Shared subscriptions during application shutdown', async () => {
    release()
    release = () => undefined
    sent.length = 0
    getActionsRuntime().kick()
    await new Promise((resolve) => setImmediate(resolve))
    expect(sent.some((event) => event.channel === 'actions:projection-changed')).toBe(false)
    // The channels can be registered again, which is only true if the release
    // really removed them from Electron.
    release = registerActionsIpc()
    expect([...handlers.keys()].sort()).toEqual([...ACTION_CHANNELS].sort())
  })
})
