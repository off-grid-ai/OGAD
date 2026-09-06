// Loads the private pro package's MAIN-process features, if present. In the free
// build the Vite alias resolves `@offgrid/pro/main` to proStub (default null),
// so activateMain is absent and this is a no-op. Mirrors
// mobile/src/bootstrap/loadProFeatures.ts.

import { getDB, runMigration } from '../database'
import { llm } from '../llm'
import { registerHook, unregisterHook } from './hookRegistry'
import { registerToolExtension, unregisterToolExtension, type ToolExtension } from '../tools'
import { isProEntitled } from '../licensing/license-service'
import { getForcedProActivation } from './pro-activation'
import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'

// IPC is an untyped Electron boundary. Individual handlers validate and type
// their own argument tuples before use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ProIpcHandler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown

// What the pro main entry receives. Pro registers IPC handlers + intervals +
// tool extensions itself, using these core helpers (no core→pro imports).
export interface ProMainApi {
  getDB: typeof getDB
  runMigration: typeof runMigration
  llm: typeof llm
  registerHook: typeof registerHook
  registerToolExtension: typeof registerToolExtension
  registerIpcHandler(channel: string, handler: ProIpcHandler): void
  readonly runtimeSignal: AbortSignal
  requestRelaunch(): void
  registerShutdownOwner(name: string, shutdown: () => void | Promise<void>): () => void
}

interface ActiveProRuntime {
  shutdown(): Promise<void>
}

export class ProMainActivationError extends Error {
  readonly cause: unknown

  constructor(cause: unknown) {
    super('Off Grid AI Pro could not start.')
    this.name = 'ProMainActivationError'
    this.cause = cause
  }
}

interface RuntimeSessionOptions {
  entitlementRequired: boolean
  requestRelaunch(): void
}

let activeProRuntime: ActiveProRuntime | null = null
let activeEntitlementBootstrap: ActiveProRuntime | null = null
let lifecycleTask: Promise<void> = Promise.resolve()
let applicationShutdownOwnerRegistered = false

function enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
  const result = lifecycleTask.then(operation)
  lifecycleTask = result.catch(() => {})
  return result
}

function createRuntimeSession(options: RuntimeSessionOptions): {
  api: ProMainApi
  runtime: ActiveProRuntime
} {
  const owners = new Map<string, () => void | Promise<void>>()
  const hooks = new Map<string, (...args: never[]) => unknown>()
  const toolExtensions = new Map<string, ToolExtension>()
  const ipcChannels = new Set<string>()
  const activeIpcOperations = new Set<Promise<unknown>>()
  const controller = new AbortController()
  let stopped = false

  const api: ProMainApi = {
    getDB,
    runMigration,
    llm,
    registerHook: ((name: string, fn: (...args: never[]) => unknown) => {
      registerHook(name, fn)
      hooks.set(name, fn)
    }) as typeof registerHook,
    registerToolExtension: (extension: ToolExtension) => {
      registerToolExtension(extension)
      toolExtensions.set(extension.id, extension)
    },
    registerIpcHandler: (channel, handler) => {
      if (ipcChannels.has(channel)) throw new Error(`Pro IPC already registered: ${channel}`)
      ipcMain.handle(channel, (event, ...args) => {
        if (stopped || (options.entitlementRequired && !proEnabled())) {
          throw new Error('Off Grid AI Pro access is required.')
        }
        const operation = Promise.resolve(handler(event, ...args))
        activeIpcOperations.add(operation)
        void operation.finally(() => activeIpcOperations.delete(operation)).catch(() => {})
        return operation
      })
      ipcChannels.add(channel)
    },
    runtimeSignal: controller.signal,
    requestRelaunch: options.requestRelaunch,
    registerShutdownOwner: (name, shutdown) => {
      if (owners.has(name)) throw new Error(`Pro runtime owner already registered: ${name}`)
      owners.set(name, shutdown)
      return () => {
        if (!stopped && owners.get(name) === shutdown) owners.delete(name)
      }
    }
  }

  return {
    api,
    runtime: {
      async shutdown(): Promise<void> {
        if (stopped) return
        stopped = true
        controller.abort()

        // Close every entry point before service cleanup yields. No new paid work
        // can enter while capture, Sync, clipboard, and owned jobs are stopping.
        for (const channel of ipcChannels) ipcMain.removeHandler(channel)
        ipcChannels.clear()
        for (const [name, hook] of hooks) unregisterHook(name, hook)
        for (const [id, extension] of toolExtensions) unregisterToolExtension(id, extension)

        const stops = [...owners.values()].reverse().map((shutdown) => {
          try {
            return Promise.resolve(shutdown())
          } catch (error) {
            return Promise.reject(error)
          }
        })
        const results = await Promise.allSettled(stops)
        await Promise.allSettled([...activeIpcOperations])
        for (const result of results) {
          if (result.status === 'rejected') {
            console.error('[pro] runtime shutdown failed', result.reason)
          }
        }
      }
    }
  }
}

export async function loadProEntitlementProvider(): Promise<void> {
  let pro: unknown
  try {
    pro = await import('@offgrid/pro/main')
  } catch {
    return
  }
  const register = (
    pro as {
      registerEntitlementProvider?: () => void | Promise<void>
    }
  ).registerEntitlementProvider
  if (typeof register === 'function') await register()
}

/** Whether pro features should activate. The pro submodule must be present AND
 *  the user entitled by a valid Keygen license. Local env override (dev/contributor):
 *    OFFGRID_PRO=0 → force free even with pro code bundled,
 *    OFFGRID_PRO=1 → force pro on without a license only in development,
 *    unset/other   → license-gated (the real paid path; see license-service). */
export function proEnabled(): boolean {
  return (
    getForcedProActivation(__OFFGRID_PRO__, process.env.OFFGRID_PRO, app.isPackaged) ??
    isProEntitled()
  )
}

export function proEntitlementBootstrapEnabled(): boolean {
  return getForcedProActivation(__OFFGRID_PRO__, process.env.OFFGRID_PRO, app.isPackaged) !== false
}

async function stopRuntime(runtime: ActiveProRuntime | null): Promise<void> {
  await runtime?.shutdown()
}

async function stopAllProRuntimes(): Promise<void> {
  const full = activeProRuntime
  const bootstrap = activeEntitlementBootstrap
  activeProRuntime = null
  activeEntitlementBootstrap = null
  await Promise.allSettled([stopRuntime(full), stopRuntime(bootstrap)])
}

async function loadProFeaturesMainNow(): Promise<void> {
  let pro: unknown
  try {
    pro = await import('@offgrid/pro/main')
  } catch (cause) {
    if (proEnabled()) {
      console.error('[pro] paid runtime import failed', cause)
      throw new ProMainActivationError(cause)
    }
    return // free / contributor build: package not present
  }
  const forced = getForcedProActivation(__OFFGRID_PRO__, process.env.OFFGRID_PRO, app.isPackaged)
  if (forced === false) {
    await stopAllProRuntimes()
    console.log('[pro] disabled via OFFGRID_PRO=0')
    return
  }
  const { applicationShutdown, requestApplicationRelaunch } = await import('../shutdown')
  if (!applicationShutdownOwnerRegistered) {
    applicationShutdownOwnerRegistered = true
    applicationShutdown.register({
      name: 'pro:runtime-sessions',
      shutdown: stopAllProRuntimes
    })
  }
  const requestRelaunch = (): void => requestApplicationRelaunch(app)
  if (!proEnabled()) {
    if (activeEntitlementBootstrap) return
    const activateBootstrap = (
      pro as {
        activateEntitlementBootstrapMain?: (api: ProMainApi) => void | Promise<void>
      }
    ).activateEntitlementBootstrapMain
    if (typeof activateBootstrap !== 'function') return
    const session = createRuntimeSession({ entitlementRequired: false, requestRelaunch })
    try {
      await activateBootstrap(session.api)
      activeEntitlementBootstrap = session.runtime
      console.log('[pro] entitlement pairing bootstrap activated')
    } catch (e) {
      await session.runtime.shutdown()
      console.error('[pro] entitlement pairing bootstrap failed', e)
    }
    return
  }
  const activateMain = (pro as { activateMain?: (api: ProMainApi) => void | Promise<void> })
    .activateMain
  if (typeof activateMain !== 'function') {
    const cause = new Error('The paid runtime does not export activateMain.')
    console.error('[pro] paid runtime activation entry is missing', cause)
    throw new ProMainActivationError(cause)
  }
  if (activeProRuntime) return
  const bootstrap = activeEntitlementBootstrap
  activeEntitlementBootstrap = null
  await stopRuntime(bootstrap)
  const session = createRuntimeSession({ entitlementRequired: true, requestRelaunch })
  try {
    await activateMain(session.api)
    activeProRuntime = session.runtime
    console.log('[pro] main features activated')
  } catch (e) {
    await session.runtime.shutdown()
    console.error('[pro] activateMain failed', e)
    throw new ProMainActivationError(e)
  }
}

export function loadProFeaturesMain(): Promise<void> {
  return enqueueLifecycle(loadProFeaturesMainNow)
}

/** Stop paid work in the current process, then keep only the entitlement-recovery
 * transport available. The caller can await this to observe complete teardown. */
export function deactivateProFeaturesMain(): Promise<void> {
  return enqueueLifecycle(async () => {
    if (proEnabled()) return
    const runtime = activeProRuntime
    activeProRuntime = null
    await stopRuntime(runtime)
    if (runtime) await loadProFeaturesMainNow()
    console.log('[pro] main features deactivated after entitlement loss')
  })
}
