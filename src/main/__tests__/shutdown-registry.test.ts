import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ShutdownRegistry,
  commitApplicationRelaunch,
  installApplicationShutdown,
  registerCoreShutdownOwners,
  requestApplicationRelaunch,
  type ApplicationRelaunchOptions,
  type ShutdownFailure
} from '../shutdown'

/**
 * Quitting, and coming back.
 *
 * Electron does NOT wait for a before-quit promise. That single fact shapes this whole file: every owner's
 * teardown has to be STARTED in the listener's original call stack, before the first await, or the process
 * exits with helpers still running and sockets still bound. The next launch then finds a port taken by a
 * dead app's leftovers - the failure that shows up as "the chat engine is down" on a machine that was
 * working ten seconds earlier.
 *
 * The other rule is order: teardown runs in reverse registration order, so Pro resources stop before the
 * Core runtimes and sockets they are still using.
 *
 * All of it is pure lifecycle logic - no Electron, no boundary to fake. The quit source and the relaunch
 * source are interfaces the registry is handed.
 */

describe('the shutdown registry', () => {
  it('stops every registered owner', async () => {
    const registry = new ShutdownRegistry()
    const stopped: string[] = []
    registry.register({ name: 'a', shutdown: () => void stopped.push('a') })
    registry.register({ name: 'b', shutdown: () => void stopped.push('b') })

    await registry.shutdown()

    expect(stopped.sort()).toEqual(['a', 'b'])
  })

  it('stops them in reverse registration order', async () => {
    const registry = new ShutdownRegistry()
    const stopped: string[] = []
    registry.register({ name: 'core:socket', shutdown: () => void stopped.push('core:socket') })
    registry.register({ name: 'pro:capture', shutdown: () => void stopped.push('pro:capture') })

    await registry.shutdown()

    // Construction order in, reverse order out: capture is using the socket, so it must stop first. Tearing
    // the socket down underneath a live consumer is how a clean quit produces an error on the way out.
    expect(stopped).toEqual(['pro:capture', 'core:socket'])
  })

  it('starts every teardown before the first await', async () => {
    const registry = new ShutdownRegistry()
    const started: string[] = []
    const gate = { resolve: () => {} }
    registry.register({
      name: 'slow',
      shutdown: () => {
        started.push('slow')
        return new Promise<void>((resolve) => {
          gate.resolve = resolve
        })
      }
    })
    registry.register({ name: 'fast', shutdown: () => void started.push('fast') })

    const pending = registry.shutdown()

    // Synchronously after calling shutdown(), with nothing awaited: both owners have already been asked to
    // stop. Electron will not wait for us, so a helper kill or a socket close that only happens after an
    // await may never happen at all.
    expect(started).toEqual(['fast', 'slow'])
    gate.resolve()
    await pending
  })

  it('reports which owner failed, and stops the rest anyway', async () => {
    const registry = new ShutdownRegistry()
    const stopped: string[] = []
    registry.register({ name: 'first', shutdown: () => void stopped.push('first') })
    registry.register({
      name: 'broken',
      shutdown: () => Promise.reject(new Error('port was already gone'))
    })
    registry.register({ name: 'last', shutdown: () => void stopped.push('last') })

    const failures = await registry.shutdown()

    // One resource failing to close must not abandon the others - that is how a quit leaves a model worker
    // alive. The failure is returned rather than thrown, named, so it can be logged against its owner.
    expect(stopped.sort()).toEqual(['first', 'last'])
    expect(failures).toEqual([{ owner: 'broken', error: expect.any(Error) }])
  })

  it('catches an owner that throws synchronously, not just one that rejects', async () => {
    const registry = new ShutdownRegistry()
    registry.register({
      name: 'throws-now',
      shutdown: () => {
        throw new Error('called on a disposed handle')
      }
    })
    registry.register({ name: 'fine', shutdown: () => undefined })

    const failures = await registry.shutdown()

    // A synchronous throw happens while the loop is still building the list of promises. Uncaught, it would
    // abort the remaining owners' teardown entirely.
    expect(failures).toEqual([{ owner: 'throws-now', error: expect.any(Error) }])
  })

  it('has nothing to report when everything closes cleanly', async () => {
    const registry = new ShutdownRegistry()
    registry.register({ name: 'a', shutdown: () => undefined })

    await expect(registry.shutdown()).resolves.toEqual([])
  })

  it('runs once, however many times quit arrives', async () => {
    const registry = new ShutdownRegistry()
    const shutdown = vi.fn()
    registry.register({ name: 'a', shutdown })

    const first = registry.shutdown()
    const second = registry.shutdown()

    // The same promise, not a second teardown. Electron can emit before-quit more than once, and stopping a
    // resource twice is at best noise and at worst an error on an already-closed handle.
    expect(second).toBe(first)
    await first
    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it('refuses two owners with the same name', () => {
    const registry = new ShutdownRegistry()
    registry.register({ name: 'core:model-gateway', shutdown: () => undefined })

    // Loudly, at registration time. A silent overwrite would leave one resource with nothing to close it, and
    // the leak would only appear as a busy port on the next launch.
    expect(() =>
      registry.register({ name: 'core:model-gateway', shutdown: () => undefined })
    ).toThrow('Shutdown owner already registered: core:model-gateway')
  })

  it('lets an owner unregister while the app is still running', async () => {
    const registry = new ShutdownRegistry()
    const shutdown = vi.fn()
    const unregister = registry.register({ name: 'transient', shutdown })

    unregister()
    await registry.shutdown()

    // A resource whose life is shorter than the app's - a window, a transfer - must be able to take itself
    // off the list, or teardown calls into something already gone.
    expect(shutdown).not.toHaveBeenCalled()
  })

  it('ignores an unregister that arrives after teardown has begun', async () => {
    const registry = new ShutdownRegistry()
    const unregister = registry.register({ name: 'a', shutdown: () => undefined })

    await registry.shutdown()

    // The list is already emptied and the work already dispatched. Nothing to remove, and nothing that should
    // throw at a caller who is unmounting during a quit.
    expect(() => unregister()).not.toThrow()
  })

  it('lets a name be reused after its owner unregistered', () => {
    const registry = new ShutdownRegistry()
    const unregister = registry.register({ name: 'window:1', shutdown: () => undefined })
    unregister()

    // Windows come and go under stable names. Holding the name for ever would make the second window fail to
    // register its own teardown.
    expect(() => registry.register({ name: 'window:1', shutdown: () => undefined })).not.toThrow()
  })

  it('does not let a stale unregister remove its replacement', async () => {
    const registry = new ShutdownRegistry()
    const staleUnregister = registry.register({ name: 'window:1', shutdown: () => undefined })
    staleUnregister()
    const replacement = vi.fn()
    registry.register({ name: 'window:1', shutdown: replacement })

    staleUnregister()
    await registry.shutdown()

    // Calling an old unregister twice must not silently deregister the NEW owner of that name - it would leave
    // the live window's resources with nothing to close them.
    expect(replacement).toHaveBeenCalledTimes(1)
  })

  it('stops an owner that registers DURING teardown, immediately', async () => {
    const registry = new ShutdownRegistry()
    const late = vi.fn()

    await registry.shutdown()
    const unregister = registry.register({ name: 'late', shutdown: late })

    // A subsystem can finish starting up just as the user quits. Adding it to a list that will never be read
    // would leak it, so it is torn down on the spot - and its unregister is a no-op rather than a trap.
    expect(late).toHaveBeenCalledTimes(1)
    expect(() => unregister()).not.toThrow()
  })

  it('swallows a failure from an owner that registered during teardown', async () => {
    const registry = new ShutdownRegistry()
    await registry.shutdown()

    // Nobody is left to collect this failure - shutdown() has already resolved - so it must not surface as an
    // unhandled rejection while the process is on its way out.
    expect(() =>
      registry.register({
        name: 'late-and-broken',
        shutdown: () => Promise.reject(new Error('nope'))
      })
    ).not.toThrow()
    await Promise.resolve()
  })
})

describe('registering the core resources', () => {
  it('registers all four in construction order, so teardown reverses it', async () => {
    const registry = new ShutdownRegistry()
    const stopped: string[] = []

    registerCoreShutdownOwners(registry, {
      stopGateway: () => void stopped.push('gateway'),
      stopMediaServer: () => void stopped.push('media'),
      stopModelRuntimes: () => void stopped.push('runtimes'),
      stopModelDownloads: () => void stopped.push('downloads')
    })
    await registry.shutdown()

    // Model workers before the sockets that host them, downloads before the runtimes they feed. This order is
    // the reason the registry reverses rather than the caller listing things backwards.
    expect(stopped).toEqual(['downloads', 'runtimes', 'media', 'gateway'])
  })
})

describe('the Electron quit seam', () => {
  it('tears down when will-quit fires, and reports each failure', async () => {
    const listeners: (() => void)[] = []
    const source = {
      on: (_event: 'will-quit', listener: () => void) => listeners.push(listener),
      removeListener: vi.fn()
    }
    const registry = new ShutdownRegistry()
    registry.register({ name: 'broken', shutdown: () => Promise.reject(new Error('stuck')) })
    const reported: ShutdownFailure[] = []

    installApplicationShutdown(source, registry, (failure) => reported.push(failure))
    listeners[0]!()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(reported).toEqual([{ owner: 'broken', error: expect.any(Error) }])
  })

  it('removes its own listener BEFORE cleanup starts', () => {
    const listeners: (() => void)[] = []
    const source = {
      on: (_event: 'will-quit', listener: () => void) => listeners.push(listener),
      removeListener: vi.fn()
    }
    const registry = new ShutdownRegistry()

    installApplicationShutdown(source, registry, () => {})
    listeners[0]!()

    // Detached first, so a second will-quit cannot start a second teardown, and no lifecycle listener
    // outlives the resources it refers to.
    expect(source.removeListener).toHaveBeenCalledWith('will-quit', listeners[0])
  })

  it('a quit that gets cancelled leaves downloads working; only a committed quit closes them', async () => {
    // The real queue, registered the way the application registers it. Its `shuttingDown` is
    // one-way by design, so whatever event drives this decides whether a process that keeps
    // running can still download — the macOS session that refused every download for hours while
    // the app was open, because a deferred quit had already torn it down.
    const { modelDownloadQueue } = await import('../models/download-queue')
    const listeners: Record<string, (() => void)[]> = {}
    const app = {
      on: (event: string, listener: () => void) => (listeners[event] ??= []).push(listener),
      removeListener: () => {}
    } as unknown as Parameters<typeof installApplicationShutdown>[0]
    const registry = new ShutdownRegistry()
    registry.register({
      name: 'core:model-downloads',
      shutdown: () => modelDownloadQueue.shutdown()
    })
    installApplicationShutdown(app, registry, () => {})

    // BEFORE: downloads are open.
    expect(modelDownloadQueue.isAccepting()).toBe(true)

    // A quit is REQUESTED and then cancelled — which is what the app itself does, to unload the
    // model engine first. Nothing is torn down, because nothing is going away yet.
    listeners['before-quit']?.forEach((l) => l())
    await Promise.resolve()
    expect(modelDownloadQueue.isAccepting()).toBe(true)

    // The quit is COMMITTED. Now, and only now, the queue closes.
    listeners['will-quit']?.forEach((l) => l())
    await Promise.resolve()
    expect(modelDownloadQueue.isAccepting()).toBe(false)
  })

  it('can be uninstalled, and uninstalling twice is harmless', () => {
    const source = { on: vi.fn(), removeListener: vi.fn() }

    const uninstall = installApplicationShutdown(source, new ShutdownRegistry(), () => {})
    uninstall()
    uninstall()

    // Guarded by an `installed` flag: removing the same listener twice would be harmless with Electron but
    // this keeps the seam honest for any source that counts subscriptions.
    expect(source.removeListener).toHaveBeenCalledTimes(1)
  })
})

describe('relaunching', () => {
  const realEnv = { ...process.env }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    process.env = { ...realEnv }
  })

  it('quits first and spawns the replacement only after shutdown', () => {
    const order: string[] = []
    const source = {
      quit: () => order.push('quit'),
      relaunch: () => order.push('relaunch')
    }

    requestApplicationRelaunch(source)
    commitApplicationRelaunch(source)

    // Starting the replacement first routes it into the still-alive single instance, which leaves a new window
    // backed by services that have already been torn down - a window that looks fine and does nothing.
    expect(order).toEqual(['quit', 'relaunch'])
  })

  it('does nothing on commit when no relaunch was requested', () => {
    const source = { quit: vi.fn(), relaunch: vi.fn() }

    commitApplicationRelaunch(source)

    // An ordinary quit also reaches this commit point. Relaunching there would make the app impossible to
    // close.
    expect(source.relaunch).not.toHaveBeenCalled()
  })

  it('relaunches once, so a second commit cannot resurrect the app', () => {
    const source = { quit: vi.fn(), relaunch: vi.fn() }

    requestApplicationRelaunch(source)
    commitApplicationRelaunch(source)
    commitApplicationRelaunch(source)

    expect(source.relaunch).toHaveBeenCalledTimes(1)
  })

  it('restarts the whole dev command in development, not just Electron', () => {
    process.env.NODE_ENV_ELECTRON_VITE = 'development'
    process.env.npm_node_execpath = '/usr/bin/node'
    process.env.npm_execpath = '/usr/lib/npm/bin/npm-cli.js'
    let options: ApplicationRelaunchOptions | undefined
    const source = {
      quit: vi.fn(),
      relaunch: (o?: ApplicationRelaunchOptions) => void (options = o)
    }

    requestApplicationRelaunch(source)
    commitApplicationRelaunch(source)

    // electron-vite kills its renderer server when the Electron child quits, so relaunching Electron alone
    // leaves the new window pointing at a dead localhost URL. The whole npm command comes back instead.
    expect(options).toEqual({
      execPath: '/usr/bin/node',
      args: ['/usr/lib/npm/bin/npm-cli.js', 'run', 'dev']
    })
  })

  it('relaunches Electron alone in a packaged build', () => {
    delete process.env.NODE_ENV_ELECTRON_VITE
    let options: ApplicationRelaunchOptions | undefined | 'unset' = 'unset'
    const source = {
      quit: vi.fn(),
      relaunch: (o?: ApplicationRelaunchOptions) => void (options = o)
    }

    requestApplicationRelaunch(source)
    commitApplicationRelaunch(source)

    // No npm in a shipped app: the default relaunch is correct, and passing a dev execPath would try to start
    // node from a path that does not exist on the user's machine.
    expect(options).toBeUndefined()
  })

  it('falls back to Electron alone when development metadata is missing, and says why', () => {
    process.env.NODE_ENV_ELECTRON_VITE = 'development'
    delete process.env.npm_node_execpath
    delete process.env.npm_execpath
    let options: ApplicationRelaunchOptions | undefined | 'unset' = 'unset'
    const source = {
      quit: vi.fn(),
      relaunch: (o?: ApplicationRelaunchOptions) => void (options = o)
    }

    requestApplicationRelaunch(source)
    commitApplicationRelaunch(source)

    // Electron started by hand rather than through npm. Restarting what we can beats refusing to restart, and
    // the log explains why the renderer may not come back.
    expect(options).toBeUndefined()
    expect(console.error).toHaveBeenCalledWith(
      '[relaunch] development runtime is missing npm launch metadata; restarting Electron only'
    )
  })
})
