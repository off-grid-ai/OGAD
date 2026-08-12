import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CACHE_CLEANUP_CHANNEL } from '../../shared/ipc-contracts'
import {
  BACKUP_EXPORT_ALL_CHANNEL,
  BACKUP_IMPORT_CHANNEL
} from '../../shared/backup-contracts'

/**
 * The bridge, which is the entire vocabulary the renderer has for talking to this machine.
 *
 * Every method here is a thin forward, and that is exactly what makes it worth testing: a method that
 * forwards nothing is a DEAD BUTTON. Nothing errors, no type complains, the UI simply does not work - and
 * the failure surfaces to a user rather than to a build. So the sweep below walks the whole exposed object
 * and insists each function reaches the main process somehow.
 *
 * The two synchronous reads matter for a different reason: they decide, at preload time, whether the
 * licensed half of the UI is even reachable. Getting them wrong locks a paying user out of what they bought.
 *
 * Electron is the boundary and the only thing faked. The channel names, the argument forwarding and the
 * unsubscribe behaviour are real.
 */

const electron = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invoke: vi.fn(),
  send: vi.fn(),
  sendSync: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  removeAllListeners: vi.fn(),
  exposeThrows: false
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => {
      if (electron.exposeThrows) throw new Error('context isolation is off')
      electron.exposed.set(key, value)
    }
  },
  ipcRenderer: {
    invoke: electron.invoke,
    send: electron.send,
    sendSync: electron.sendSync,
    on: electron.on,
    removeListener: electron.removeListener,
    removeAllListeners: electron.removeAllListeners
  }
}))

type Bridge = Record<string, unknown>

const loadBridge = async (
  sendSyncAnswers: Record<string, unknown> = {}
): Promise<Bridge> => {
  vi.resetModules()
  electron.exposed.clear()
  electron.invoke.mockReset()
  electron.invoke.mockResolvedValue(undefined)
  electron.on.mockReset()
  electron.sendSync.mockReset()
  electron.sendSync.mockImplementation((channel: string) => sendSyncAnswers[channel])
  await import('../index')
  return electron.exposed.get('api') as Bridge
}

/** Every leaf function on the bridge, with the dotted path it lives at. */
const leafFunctions = (
  value: unknown,
  trail: string[] = []
): { path: string; fn: (...args: unknown[]) => unknown }[] => {
  if (typeof value === 'function') {
    return [{ path: trail.join('.'), fn: value as (...args: unknown[]) => unknown }]
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leafFunctions(child, [...trail, key])
  )
}

describe('the preload bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    electron.exposeThrows = false
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('exposes itself to the renderer as window.api', async () => {
    const bridge = await loadBridge()

    expect(bridge).toBeTruthy()
    expect(electron.exposed.has('api')).toBe(true)
  })

  it('survives a failure to expose instead of leaving a blank window', async () => {
    electron.exposeThrows = true
    vi.resetModules()

    // A preload that throws takes the whole renderer with it - no UI at all, and no message explaining why.
    // The failure is logged and the app continues into its degraded no-bridge state.
    await expect(import('../index')).resolves.toBeTruthy()
    expect(console.error).toHaveBeenCalledWith('Failed to expose API:', expect.any(Error))
  })

  describe('the two answers read synchronously at preload time', () => {
    it('reports the licensed tier the main process decided on', async () => {
      const bridge = await loadBridge({
        'pro:is-enabled': true,
        'pro:entitlement-bootstrap-enabled': true
      })

      // Read synchronously and once, so the renderer can lock or unlock pro navigation on its first paint
      // rather than flashing the wrong UI while an async answer arrives.
      expect(bridge.isPro).toBe(true)
      expect(bridge.proEntitlementBootstrapEnabled).toBe(true)
      expect(electron.sendSync).toHaveBeenCalledWith('pro:is-enabled')
    })

    it('stays free when the answer is anything other than true', async () => {
      for (const answer of [false, undefined, null, 'true', 1]) {
        const bridge = await loadBridge({ 'pro:is-enabled': answer })
        // Strict equality on purpose: an unregistered handler answers undefined, and a truthy string would
        // otherwise unlock the paid half of the app on a free build.
        expect(bridge.isPro).toBe(false)
      }
    })

    it('bridges the host platform once, so renderer copy and availability agree', async () => {
      const bridge = await loadBridge()

      expect(bridge.platform).toBe(process.platform)
    })
  })

  describe('every method reaches the main process', () => {
    it('has no dead ends: each function invokes, sends, or subscribes', async () => {
      const bridge = await loadBridge()
      const leaves = leafFunctions(bridge)
      expect(leaves.length).toBeGreaterThan(100)

      const dead: string[] = []
      for (const { path, fn } of leaves) {
        electron.invoke.mockClear()
        electron.send.mockClear()
        electron.on.mockClear()
        electron.sendSync.mockClear()
        electron.removeListener.mockClear()
        electron.removeAllListeners.mockClear()
        try {
          // Called with a couple of harmless arguments: some methods take an id or a callback, and a wrapper
          // that ignores what it was given is still a wrapper that must reach main.
          fn('probe-argument', () => undefined)
        } catch {
          // A wrapper that throws on a probe argument has still not necessarily talked to main; the counters
          // below decide.
        }
        // removeListener counts too: proOff exists precisely to detach a listener, so a sweep that ignored it
        // would report the one honest unsubscriber on the bridge as a dead end.
        const talked =
          electron.invoke.mock.calls.length +
            electron.send.mock.calls.length +
            electron.on.mock.calls.length +
            electron.sendSync.mock.calls.length +
            electron.removeListener.mock.calls.length +
            electron.removeAllListeners.mock.calls.length >
          0
        if (!talked) dead.push(path)
      }

      // This is the assertion that would have caught a dead button: a bridge method that quietly does
      // nothing. Naming them makes a regression readable instead of a bare count mismatch.
      expect(dead).toEqual([])
    })

    it('forwards the arguments it was given, rather than dropping them', async () => {
      const bridge = await loadBridge()
      const license = bridge.license as Record<
        'activate' | 'deactivate',
        (...args: unknown[]) => unknown
      >

      license.activate('OFFGRID-A-KEY')
      expect(electron.invoke).toHaveBeenCalledWith('license:activate', 'OFFGRID-A-KEY')

      license.deactivate('machine-7')
      expect(electron.invoke).toHaveBeenCalledWith('license:deactivate', 'machine-7')
    })

    it('passes a pro channel and its arguments straight through', async () => {
      const bridge = await loadBridge()

      ;(bridge.proInvoke as (channel: string, ...args: unknown[]) => unknown)(
        'pro:sync:pair',
        'ABCD2345',
        { trusted: true }
      )

      // The generic passthrough is what lets pro renderer code reach pro IPC without this core bundle
      // enumerating every channel - so it must not rewrite or swallow anything on the way.
      expect(electron.invoke).toHaveBeenCalledWith('pro:sync:pair', 'ABCD2345', { trusted: true })
    })
  })

  describe('subscriptions', () => {
    const capture = (): { fire: (...args: unknown[]) => void; channel: string } => {
      const [channel, listener] = electron.on.mock.calls.at(-1) as [
        string,
        (event: unknown, ...args: unknown[]) => void
      ]
      return { channel, fire: (...args) => listener({}, ...args) }
    }

    it('delivers the payload without the Electron event object', async () => {
      const bridge = await loadBridge()
      const seen: unknown[] = []

      ;(bridge.proOn as (channel: string, cb: (...a: unknown[]) => void) => unknown)(
        'pro:sync:changed',
        (...args) => seen.push(args)
      )
      capture().fire({ devices: 2 })

      // The renderer must never be handed the IpcRendererEvent - it carries a sender it has no business
      // touching, and it would be the first argument of every callback.
      expect(seen).toEqual([[{ devices: 2 }]])
    })

    it('hands back an unsubscribe that actually removes the listener', async () => {
      const bridge = await loadBridge()

      const off = (bridge.proOn as (channel: string, cb: () => void) => () => void)(
        'pro:sync:changed',
        () => undefined
      )
      const { channel } = capture()
      const [, listener] = electron.on.mock.calls.at(-1) as [string, unknown]
      off()

      // Without this, every screen that subscribes leaks a listener on unmount and the same payload is
      // handled several times over after a few navigations.
      expect(electron.removeListener).toHaveBeenCalledWith(channel, listener)
    })

    it('removes exactly the listener it registered, not merely the channel', async () => {
      const bridge = await loadBridge()
      const proOn = bridge.proOn as (channel: string, cb: () => void) => () => void

      const offFirst = proOn('pro:sync:changed', () => undefined)
      const [, firstListener] = electron.on.mock.calls.at(-1) as [string, unknown]
      proOn('pro:sync:changed', () => undefined)
      const [, secondListener] = electron.on.mock.calls.at(-1) as [string, unknown]
      offFirst()

      // Two screens can watch one channel. Unsubscribing by channel alone would silence the other.
      expect(electron.removeListener).toHaveBeenCalledWith('pro:sync:changed', firstListener)
      expect(electron.removeListener).not.toHaveBeenCalledWith('pro:sync:changed', secondListener)
    })

    it('detaches EVERY listener on a channel when proOff is used', async () => {
      const bridge = await loadBridge()

      ;(bridge.proOff as (channel: string) => void)('pro:sync:changed')

      // Worth knowing at the call site: proOff is removeAllListeners, so it silences every subscriber on that
      // channel, not just the caller's. The unsubscribe returned by proOn is the one to use when two screens
      // watch the same channel - the test above pins that distinction.
      expect(electron.removeAllListeners).toHaveBeenCalledWith('pro:sync:changed')
    })
  })

  describe('channels that are defined once and shared', () => {
    it('uses the shared constants for backup and cache, not its own copies', async () => {
      const bridge = await loadBridge()

      ;(bridge.exportBackup as () => unknown)()
      expect(electron.invoke).toHaveBeenCalledWith(BACKUP_EXPORT_ALL_CHANNEL)

      ;(bridge.importBackup as () => unknown)()
      expect(electron.invoke).toHaveBeenCalledWith(BACKUP_IMPORT_CHANNEL)

      ;(bridge.clearAppCache as () => unknown)()
      // Imported from the contract rather than retyped here: a channel spelled in two places is a channel
      // that eventually differs in one of them, and the failure is a silently dead feature.
      expect(electron.invoke).toHaveBeenCalledWith(CACHE_CLEANUP_CHANNEL)
    })
  })
})
