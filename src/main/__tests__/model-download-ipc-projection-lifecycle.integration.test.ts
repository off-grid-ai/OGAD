import { describe, expect, it, vi } from 'vitest'
import type { ModelsOperationsSnapshot } from '@offgrid/application'
import {
  createOffGridApplication,
  EMPTY_MODELS_OPERATIONS,
  reduceModelsOperations
} from '@offgrid/application'
import {
  ModelDownloadIpcProjectionLifecycle,
  observeModelControlIpcProjection,
  observeModelOperationsIpcProjection
} from '../model-download-ipc-projection'
import { ShutdownRegistry } from '../shutdown'
import { desktopModelWorkspacePorts } from '../model-services'

describe('model download IPC projection lifecycle', () => {
  it('forwards the Shared control projection without deriving a desktop copy', () => {
    const projection = { kinds: ['text'], downloads: [] }
    const send = vi.fn()
    const release = vi.fn()
    const unsubscribe = observeModelControlIpcProjection({
      models: {
        watch: (selector, listener) => {
          expect(selector({ control: projection } as never)).toBe(projection)
          listener(projection as never)
          return release
        }
      },
      targets: () => [{ isDestroyed: () => false, send }],
      report: vi.fn()
    })

    expect(send).toHaveBeenCalledWith('models:control-projection-changed', projection)
    unsubscribe()
    expect(release).toHaveBeenCalledOnce()
  })

  it('isolates a broken target and continues the same Shared projection to every live window', () => {
    const projection = { kinds: ['text'], downloads: [] }
    const destroyed = vi.fn()
    const broken = vi.fn(() => {
      throw new Error('window closed during send')
    })
    const delivered = vi.fn()
    const report = vi.fn()

    observeModelControlIpcProjection({
      models: {
        watch: (_selector, listener) => {
          listener(projection as never)
          return () => undefined
        }
      },
      targets: () => [
        { isDestroyed: () => true, send: destroyed },
        { isDestroyed: () => false, send: broken },
        { isDestroyed: () => false, send: delivered }
      ],
      report
    })

    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Could not publish models:control-projection-changed.' })
    )
    expect(report.mock.calls[0]?.[0].cause).toEqual(
      expect.objectContaining({ message: 'window closed during send' })
    )
    expect(destroyed).not.toHaveBeenCalled()
    expect(delivered).toHaveBeenCalledWith('models:control-projection-changed', projection)
  })

  it('forwards the real Shared projector operation projection without translating progress', () => {
    const started = reduceModelsOperations(EMPTY_MODELS_OPERATIONS, {
      type: 'model_projector_repair_started',
      operationId: 'repair-1',
      modelId: 'local/vision'
    })
    const operations = reduceModelsOperations(started, {
      type: 'model_projector_repair_progress',
      operationId: 'repair-1',
      modelId: 'local/vision',
      bytesDownloaded: 150,
      totalBytes: 100
    })
    const send = vi.fn()

    observeModelOperationsIpcProjection({
      models: {
        watch: (selector, listener) => {
          listener(selector({ operations } as never))
          return () => undefined
        }
      },
      targets: () => [{ isDestroyed: () => false, send }],
      report: vi.fn()
    })

    expect(send).toHaveBeenCalledWith('models:operations-projection-changed', operations)
    expect(operations.active[0]?.progress).toEqual({
      bytesDownloaded: 100,
      totalBytes: 100,
      percent: 100
    })
  })

  it('installs each Shared projection once and releases all subscriptions on shutdown', async () => {
    const releaseEvents = vi.fn()
    const releaseControl = vi.fn()
    const releaseOperations = vi.fn()
    const events = vi.fn(() => releaseEvents)
    const watch = vi.fn().mockReturnValueOnce(releaseControl).mockReturnValueOnce(releaseOperations)
    const shutdown = new ShutdownRegistry()
    const lifecycle = new ModelDownloadIpcProjectionLifecycle({
      targets: () => [],
      report: vi.fn(),
      registerShutdown: (owner) => shutdown.register(owner)
    })
    const models = { events, watch } as never

    lifecycle.install(models)
    lifecycle.install(models)

    expect(events).toHaveBeenCalledOnce()
    expect(watch).toHaveBeenCalledTimes(2)
    expect(await shutdown.shutdown()).toEqual([])
    expect(releaseEvents).toHaveBeenCalledOnce()
    expect(releaseControl).toHaveBeenCalledOnce()
    expect(releaseOperations).toHaveBeenCalledOnce()
  })

  it('installs only after receiving the real application and owns one shutdown release', async () => {
    const application = createOffGridApplication({ models: desktopModelWorkspacePorts })
    const shutdown = new ShutdownRegistry()
    const send = vi.fn()
    const lifecycle = new ModelDownloadIpcProjectionLifecycle({
      targets: () => [{ isDestroyed: () => false, send }],
      report: vi.fn(),
      registerShutdown: (owner) => {
        shutdown.register(owner)
      }
    })

    expect(() => lifecycle.install(application.models)).not.toThrow()
    expect(() => lifecycle.install(application.models)).not.toThrow()
    expect(await shutdown.shutdown()).toEqual([])
    expect(send).not.toHaveBeenCalled()
  })
})

describe('refused repair-projector intent', () => {
  it('lands the refusal in the canonical Shared operations projection that Electron forwards', async () => {
    const application = createOffGridApplication({ models: desktopModelWorkspacePorts })
    const published: ModelsOperationsSnapshot[] = []
    const release = observeModelOperationsIpcProjection({
      models: application.models,
      targets: () => [
        {
          isDestroyed: () => false,
          send: (_channel, projection) => published.push(projection as ModelsOperationsSnapshot)
        }
      ],
      report: vi.fn()
    })
    try {
      const outcome = await application.models.control({
        type: 'repair-projector',
        modelId: 'missing/vision-model',
        operationId: 'repair-refused'
      })

      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      const projected = application.models.snapshot().operations
      expect(projected.recent.find((op) => op.operationId === 'repair-refused')).toMatchObject({
        kind: 'control',
        controlOperation: 'repair-projector',
        modelId: 'missing/vision-model',
        state: 'failed',
        failure: outcome.failure
      })
      expect(projected.active.some((op) => op.operationId === 'repair-refused')).toBe(false)
      expect(published.at(-1)).toEqual(projected)
    } finally {
      release()
    }
  })
})
