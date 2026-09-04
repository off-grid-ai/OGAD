import { describe, expect, it, vi } from 'vitest'
import { createOffGridApplication } from '@offgrid/application'
import { ModelDownloadIpcProjectionLifecycle } from '../model-download-ipc-projection'
import { ShutdownRegistry } from '../shutdown'
import { desktopModelWorkspacePorts } from '../model-services'

describe('model download IPC projection lifecycle', () => {
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
