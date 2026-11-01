import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The one truth record the renderer gets about this machine's health.
 *
 * The point of this module is that the renderer interprets nothing: it does not ask what platform it is
 * on, does not decide what a denied permission means, and does not compose a status out of parts. So the
 * tests assert the composed record, and above all what it says when the permission owner FAILS - because
 * "we could not read this" and "the user denied this" must not look the same. One tells the user to open
 * System Settings; the other is a fault in the app.
 *
 * The TCC boundary (macOS permissions) and the runtime health owner are the two collaborators. The
 * permission read is faked because it is the native boundary; the composition, the labels and the failure
 * handling are all real.
 */

// The boundaries: macOS's permission store (TCC, read through Electron's systemPreferences) and the
// multicast route Local Network needs (a UDP socket). Permissions, the health composition, the setup
// health owner and the chat engine owner are all real, on a Mac, in a temp profile.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type * as Dgram from 'node:dgram'

const tcc = vi.hoisted(() => ({
  accessibility: true,
  screenRecording: true,
  localNetwork: true,
  failure: undefined as unknown,
  reads: 0
}))
vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.OFFGRID_DATA_DIR,
    isPackaged: false,
    getAppPath: () => process.cwd()
  },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] },
  shell: {},
  desktopCapturer: {},
  systemPreferences: {
    isTrustedAccessibilityClient: () => {
      tcc.reads++
      if (tcc.failure !== undefined) throw tcc.failure
      return tcc.accessibility
    },
    getMediaAccessStatus: () => (tcc.screenRecording ? 'granted' : 'denied')
  }
}))
vi.mock('node:dgram', async (importOriginal) => {
  const actual = await importOriginal<typeof Dgram>()
  const createSocket = (() => ({
    once: () => {},
    close: () => {},
    send: (_b: Buffer, _p: number, _h: string, done: (error: Error | null) => void) =>
      queueMicrotask(() => done(tcc.localNetwork ? null : new Error('EHOSTUNREACH')))
  })) as unknown as typeof actual.createSocket
  return { ...actual, default: { ...actual, createSocket }, createSocket }
})

import { getChatHealth, getSystemHealth } from '../setup'
import { llm } from '../llm'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-system-status-'))
const previous = {
  data: process.env.OFFGRID_DATA_DIR,
  platform: Object.getOwnPropertyDescriptor(process, 'platform')!
}
process.env.OFFGRID_DATA_DIR = profile
Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
afterAll(() => {
  Object.defineProperty(process, 'platform', previous.platform)
  if (previous.data === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previous.data
  fs.rmSync(profile, { recursive: true, force: true })
})

const grant = (granted: {
  accessibility: boolean
  screenRecording: boolean
  localNetwork: boolean
}): void => {
  Object.assign(tcc, granted, { failure: undefined })
}
const GRANTED = { accessibility: true, screenRecording: true, localNetwork: true }

describe('the system health record the renderer is handed', () => {
  beforeEach(() => {
    grant(GRANTED)
  })

  it('appends a component per permission to whatever the runtime reported', async () => {
    const { getRenderedSystemHealth } = await import('../system-status-ipc')

    const health = await getRenderedSystemHealth()
    const runtime = await getSystemHealth()

    // The runtime's own facts survive untouched and its components come first - permissions are added to
    // the picture, not substituted for it.
    expect(health.ramGb).toBe(runtime.ramGb)
    expect(health.activeModel).toBe(runtime.activeModel)
    expect(health.components.map(({ id }) => id)).toEqual([
      ...runtime.components.map(({ id }) => id),
      'permission-accessibility',
      'permission-screen-recording',
      'permission-local-network'
    ])
  })

  it('describes each granted permission by what it enables, not by its own name', async () => {
    const { getRenderedSystemHealth } = await import('../system-status-ipc')

    const health = await getRenderedSystemHealth()
    const detail = (id: string): string | undefined =>
      health.components.find((component) => component.id === id)?.detail

    // A user reading this wants to know what works, not that a TCC bit is set.
    expect(detail('permission-accessibility')).toBe('Capture and text insertion are allowed')
    expect(detail('permission-screen-recording')).toBe('Screen capture is allowed')
    expect(detail('permission-local-network')).toBe('Device discovery is allowed')
    expect(
      health.components
        .filter(({ id }) => id.startsWith('permission-'))
        .every(({ status }) => status === 'granted')
    ).toBe(true)
  })

  it('tells the user where to go when a permission is denied', async () => {
    grant({ accessibility: false, screenRecording: false, localNetwork: false })
    const { getRenderedSystemHealth } = await import('../system-status-ipc')

    const health = await getRenderedSystemHealth()

    // Denied is actionable, so the detail is an instruction. Saying only "denied" leaves the user with
    // nothing to do about it.
    for (const component of health.components.filter(({ id }) => id.startsWith('permission-'))) {
      expect(component.status).toBe('denied')
      expect(component.detail).toBe('Grant access in System Settings')
    }
  })

  it('reports each permission independently rather than collapsing them into one verdict', async () => {
    grant({ accessibility: true, screenRecording: false, localNetwork: true })
    const { getRenderedSystemHealth } = await import('../system-status-ipc')

    const health = await getRenderedSystemHealth()
    const status = (id: string): string | undefined =>
      health.components.find((component) => component.id === id)?.status

    // The common real state: capture is blocked while everything else is fine. A single rolled-up
    // "permissions: denied" would send the user hunting through three settings panes.
    expect(status('permission-accessibility')).toBe('granted')
    expect(status('permission-screen-recording')).toBe('denied')
    expect(status('permission-local-network')).toBe('granted')
  })

  it('says the status is UNAVAILABLE when the permission owner throws, not that it was denied', async () => {
    tcc.failure = new Error('TCC database is locked')
    const { getRenderedSystemHealth } = await import('../system-status-ipc')

    const health = await getRenderedSystemHealth()

    // This is the distinction that matters most here. Reporting a failed read as 'denied' would tell the
    // user to grant a permission they have already granted, and hide a real fault; 'down' plus the reason
    // points at the actual problem.
    const permissionComponents = health.components.filter(({ id }) => id.startsWith('permission-'))
    expect(permissionComponents).toHaveLength(3)
    for (const component of permissionComponents) {
      expect(component.status).toBe('down')
      expect(component.detail).toBe('Permission status unavailable: TCC database is locked')
    }
  })

  it('still reports the rest of the runtime when permissions cannot be read', async () => {
    tcc.failure = new Error('nope')
    const { getRenderedSystemHealth } = await import('../system-status-ipc')

    const health = await getRenderedSystemHealth()
    const runtime = await getSystemHealth()

    // A failed permission read must not blank the System Health screen - the chat engine's state is
    // exactly what a user checks that screen for.
    expect(runtime.components.length).toBeGreaterThan(0)
    expect(health.components.slice(0, runtime.components.length)).toEqual(runtime.components)
  })

  it('still reports down when the boundary rejects with something that is not an Error', async () => {
    tcc.failure = { code: 'EPERM' }
    const { getRenderedSystemHealth } = await import('../system-status-ipc')

    const health = await getRenderedSystemHealth()

    // A native boundary can reject with anything. What matters is that the status is still 'down' rather
    // than an unhandled rejection taking the whole health read with it.
    expect(health.components.at(-1)!.status).toBe('down')
    // The reason is String(error) for a non-Error, so a bare object stringifies to [object Object]. That is
    // the CURRENT behaviour, asserted rather than wished away: it is cosmetic (macOS rejects with real
    // Errors, which carry a message) and worth tidying only if a boundary is found that throws a plain
    // object the user would need to read.
    expect(health.components.at(-1)!.detail).toBe('Permission status unavailable: [object Object]')
  })
})

describe('registering the status channels', () => {
  beforeEach(() => {
    grant(GRANTED)
    tcc.reads = 0
  })

  it('answers system:health with the composed record', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const { setupSystemStatusIpc } = await import('../system-status-ipc')

    setupSystemStatusIpc({ handle: (channel, listener) => handlers.set(channel, listener) })

    expect([...handlers.keys()]).toEqual([
      'system:chat-health',
      'system:runtime-backends',
      'system:health',
      'permissions:get-status'
    ])
    const health = (await handlers.get('system:health')!({})) as {
      components: { id: string }[]
    }
    // Registered AND wired: a handler that exists but returns something else is the failure this catches.
    expect(health.components.map(({ id }) => id).slice(-3)).toEqual([
      'permission-accessibility',
      'permission-screen-recording',
      'permission-local-network'
    ])
  })

  it('answers the sidebar with chat health without reading permissions or full machine health', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const { setupSystemStatusIpc } = await import('../system-status-ipc')

    setupSystemStatusIpc({ handle: (channel, listener) => handlers.set(channel, listener) })

    await expect(handlers.get('system:chat-health')!({})).resolves.toEqual(await getChatHealth())
    expect(tcc.reads).toBe(0)
  })

  it('publishes the authoritative chat record when the engine lifecycle changes', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const publish = vi.fn()
    const { setupSystemStatusIpc } = await import('../system-status-ipc')

    setupSystemStatusIpc(
      { handle: (channel, listener) => handlers.set(channel, listener) },
      { publish }
    )
    // The chat engine's lifecycle changes: it is unloaded.
    await llm.unload()

    await vi.waitFor(() =>
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ id: 'chat' }))
    )
    expect(publish.mock.calls.at(-1)![0]).toEqual(await getChatHealth())
    expect(tcc.reads).toBe(0)
  })

  it('answers permissions:get-status from the production permission owner', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const { setupSystemStatusIpc } = await import('../system-status-ipc')

    setupSystemStatusIpc({ handle: (channel, listener) => handlers.set(channel, listener) })

    await expect(handlers.get('permissions:get-status')!({})).resolves.toEqual({
      ...GRANTED,
      allGranted: true
    })
    expect(tcc.reads).toBe(1)
  })
})
