import type { ModelsFacade } from '@offgrid/application'

interface DownloadProgressTarget {
  isDestroyed(): boolean
  send(channel: 'model:download-progress', event: unknown): void
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

/** Forward the canonical Models event without creating a second download state or event codec. */
export function observeModelDownloadIpcProjection(input: {
  models: Pick<ModelsFacade, 'events'>
  targets(): readonly DownloadProgressTarget[]
  report(error: unknown): void
}): () => void {
  return input.models.events((event) => {
    if (event.type !== 'download') return
    for (const target of input.targets()) {
      if (target.isDestroyed()) continue
      try {
        target.send('model:download-progress', event.event)
      } catch (error) {
        input.report(error)
      }
    }
  })
}

/** Install the facade-to-Electron projection only after the application root exists. */
export class ModelDownloadIpcProjectionLifecycle {
  private release: (() => void) | null = null

  constructor(private readonly ports: ModelDownloadIpcProjectionLifecyclePorts) {}

  install(models: Pick<ModelsFacade, 'events'>): void {
    if (this.release) return
    this.release = observeModelDownloadIpcProjection({
      models,
      targets: this.ports.targets,
      report: this.ports.report
    })
    this.ports.registerShutdown({
      name: 'core:model-download-projection',
      shutdown: () => {
        this.release?.()
        this.release = null
      }
    })
  }
}
