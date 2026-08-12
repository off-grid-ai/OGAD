/**
 * One application-lifecycle owner for resources created by Core and Pro.
 *
 * Subsystems expose an idempotent cleanup function; the composition roots register
 * those functions here. The registry deliberately knows nothing about Electron,
 * model engines, capture, or Pro. That keeps resource policy in one place while
 * concrete teardown remains with the resource that owns it.
 */

export interface ShutdownOwner {
  readonly name: string
  shutdown(): void | Promise<void>
}

export interface ApplicationQuitSource {
  on(event: 'will-quit', listener: () => void): unknown
  removeListener(event: 'will-quit', listener: () => void): unknown
}

export interface ApplicationRelaunchSource {
  quit(): void
  relaunch(options?: ApplicationRelaunchOptions): void
}

export interface ApplicationRelaunchOptions {
  execPath?: string
  args?: string[]
}

interface PendingApplicationRelaunch {
  options?: ApplicationRelaunchOptions
}

let pendingRelaunch: PendingApplicationRelaunch | null = null

function developmentRelaunchOptions(): ApplicationRelaunchOptions | undefined {
  if (process.env.NODE_ENV_ELECTRON_VITE !== 'development') return undefined

  const nodeExecutable = process.env.npm_node_execpath
  const npmExecutable = process.env.npm_execpath
  if (!nodeExecutable || !npmExecutable) {
    console.error(
      '[relaunch] development runtime is missing npm launch metadata; restarting Electron only'
    )
    return undefined
  }

  // electron-vite exits its renderer server when the Electron child quits. Relaunching only
  // Electron therefore leaves the replacement window pointing at a dead localhost URL. Restart
  // the complete npm dev command so main, preload, and renderer return as one runtime.
  return {
    execPath: nodeExecutable,
    args: [npmExecutable, 'run', 'dev']
  }
}

/**
 * Defer spawning the replacement process until the current process has finished its asynchronous
 * shutdown. Starting the replacement first can route it back into the still-alive single instance,
 * leaving a new window backed by services that have already been torn down.
 */
export function requestApplicationRelaunch(source: ApplicationRelaunchSource): void {
  pendingRelaunch = { options: developmentRelaunchOptions() }
  source.quit()
}

export function commitApplicationRelaunch(source: ApplicationRelaunchSource): void {
  if (!pendingRelaunch) return
  const { options } = pendingRelaunch
  pendingRelaunch = null
  source.relaunch(options)
}

export interface ShutdownFailure {
  owner: string
  error: unknown
}

export class ShutdownRegistry {
  private readonly owners = new Map<string, ShutdownOwner>()
  private shutdownPromise: Promise<ShutdownFailure[]> | null = null

  register(owner: ShutdownOwner): () => void {
    if (this.shutdownPromise) {
      void Promise.resolve(owner.shutdown()).catch(() => {})
      return () => {}
    }
    if (this.owners.has(owner.name)) {
      throw new Error(`Shutdown owner already registered: ${owner.name}`)
    }
    this.owners.set(owner.name, owner)
    return () => {
      if (!this.shutdownPromise && this.owners.get(owner.name) === owner) {
        this.owners.delete(owner.name)
      }
    }
  }

  shutdown(): Promise<ShutdownFailure[]> {
    if (this.shutdownPromise) return this.shutdownPromise

    // Reverse registration order mirrors construction order: Pro resources stop
    // before the Core runtimes and sockets they may still be using.
    const owners = [...this.owners.values()].reverse()
    this.owners.clear()
    // Invoke every owner before the first asynchronous yield. Electron does not
    // wait for before-quit promises, so helper kills, listener removal, and socket
    // close must all be initiated in the listener's original call stack.
    const stops = owners.map((owner) => {
      try {
        return Promise.resolve(owner.shutdown())
          .then<ShutdownFailure | null>(() => null)
          .catch((error): ShutdownFailure => ({ owner: owner.name, error }))
      } catch (error) {
        return Promise.resolve<ShutdownFailure | null>({ owner: owner.name, error })
      }
    })
    this.shutdownPromise = Promise.all(stops).then((results) =>
      results.filter((failure): failure is ShutdownFailure => failure !== null)
    )
    return this.shutdownPromise
  }
}

export interface CoreShutdownResources {
  stopGateway(): void | Promise<void>
  stopMediaServer(): void | Promise<void>
  stopModelRuntimes(): void | Promise<void>
  stopModelDownloads(): void | Promise<void>
}

/** Register Core resources in construction order. The registry reverses this on
 * shutdown so model workers stop before their host sockets disappear. */
export function registerCoreShutdownOwners(
  registry: ShutdownRegistry,
  resources: CoreShutdownResources
): void {
  registry.register({ name: 'core:model-gateway', shutdown: resources.stopGateway })
  registry.register({ name: 'core:media-server', shutdown: resources.stopMediaServer })
  registry.register({ name: 'core:model-runtimes', shutdown: resources.stopModelRuntimes })
  registry.register({ name: 'core:model-downloads', shutdown: resources.stopModelDownloads })
}

/** Connect the registry to the real Electron quit seam. The subscription removes
 * itself before cleanup starts, so repeated quit emission cannot create duplicate
 * work and no lifecycle listener survives teardown.
 *
 * The seam is `will-quit`, NOT `before-quit`. `before-quit` announces that a quit was
 * REQUESTED and any listener may cancel it — this app's own handler does exactly that, to
 * unload the model engine before letting the quit through. Tearing down on the request made
 * every cancelled or deferred quit permanent for the resources: teardown is one-way, so a
 * process that kept running was left with its downloads refused for the rest of its life
 * ("stuck at 0%", device-confirmed on macOS). `will-quit` fires only once the quit is
 * COMMITTED, and never when a `before-quit` was prevented, so teardown now follows the
 * application actually going away rather than someone asking whether it should. */
export function installApplicationShutdown(
  source: ApplicationQuitSource,
  registry: ShutdownRegistry,
  reportFailure: (failure: ShutdownFailure) => void
): () => void {
  let installed = true
  const remove = (): void => {
    if (!installed) return
    installed = false
    source.removeListener('will-quit', listener)
  }
  const listener = (): void => {
    remove()
    void registry.shutdown().then((failures) => failures.forEach(reportFailure))
  }
  source.on('will-quit', listener)
  return remove
}

export const applicationShutdown = new ShutdownRegistry()
