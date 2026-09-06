import type { ModelsFacade, ModelsOperationsSnapshot } from '@offgrid/application'

type ModelProjectionChannel =
  | 'model:download-progress'
  | 'models:control-projection-changed'
  | 'models:operations-projection-changed'

interface DownloadProgressTarget {
  isDestroyed(): boolean
  send(channel: ModelProjectionChannel, event: unknown): void
}

interface DownloadProjectionShutdownOwner {
  readonly name: string
  shutdown(): void | Promise<void>
}

export interface ModelDownloadIpcProjectionLifecyclePorts {
  targets(): readonly DownloadProgressTarget[]
  report(error: unknown): void
  registerShutdown(owner: DownloadProjectionShutdownOwner): void
}

function publishProjection(
  input: Pick<ModelDownloadIpcProjectionLifecyclePorts, 'targets' | 'report'>,
  channel: ModelProjectionChannel,
  projection: unknown
): void {
  for (const target of input.targets()) {
    if (target.isDestroyed()) continue
    try {
      target.send(channel, projection)
    } catch (cause) {
      input.report(new Error(`Could not publish ${channel}.`, { cause }))
    }
  }
}

/** Forward the canonical Models event without creating a second download state or event codec. */
export function observeModelDownloadIpcProjection(input: {
  models: Pick<ModelsFacade, 'events'>
  targets(): readonly DownloadProgressTarget[]
  report(error: unknown): void
}): () => void {
  return input.models.events((event) => {
    if (event.type !== 'download') return
    publishProjection(input, 'model:download-progress', event.event)
  })
}

/** Forward Shared's canonical read model. Electron transports it but does not derive it. */
export function observeModelControlIpcProjection(input: {
  models: Pick<ModelsFacade, 'watch'>
  targets(): readonly DownloadProgressTarget[]
  report(error: unknown): void
}): () => void {
  return input.models.watch(
    (snapshot) => snapshot.control,
    (control) => publishProjection(input, 'models:control-projection-changed', control)
  )
}

/** Forward Shared's lifecycle projection without rebuilding repair state in a renderer hook. */
export function observeModelOperationsIpcProjection(input: {
  models: Pick<ModelsFacade, 'watch'>
  targets(): readonly DownloadProgressTarget[]
  report(error: unknown): void
}): () => void {
  return input.models.watch(
    (snapshot) => snapshot.operations,
    (operations: ModelsOperationsSnapshot) =>
      publishProjection(input, 'models:operations-projection-changed', operations)
  )
}

/** Install the facade-to-Electron projection only after the application root exists. */
export class ModelDownloadIpcProjectionLifecycle {
  private releases: readonly (() => void)[] = []

  constructor(private readonly ports: ModelDownloadIpcProjectionLifecyclePorts) {}

  install(models: Pick<ModelsFacade, 'events' | 'watch'>): void {
    if (this.releases.length) return
    this.releases = [
      observeModelDownloadIpcProjection({
        models,
        targets: this.ports.targets,
        report: this.ports.report
      }),
      observeModelControlIpcProjection({
        models,
        targets: this.ports.targets,
        report: this.ports.report
      }),
      observeModelOperationsIpcProjection({
        models,
        targets: this.ports.targets,
        report: this.ports.report
      })
    ]
    this.ports.registerShutdown({
      name: 'core:model-download-projection',
      shutdown: () => {
        for (const release of this.releases) release()
        this.releases = []
      }
    })
  }
}
