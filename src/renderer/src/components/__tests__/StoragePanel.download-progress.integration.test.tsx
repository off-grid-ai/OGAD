// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { failed, formatTransferSpeed, ok, type ModelControlIntent } from '@offgrid/application'
import { createRealDownloadControlHarness } from './harness/real-download-control'

// Storage rows read ONLY Shared's control projection (11a15d34 "one owner for model control,
// downloads, and the workspace"): the pushed `onModelControlProjection` stream plus each control
// outcome. `Refresh` re-reads disk usage, not the projection, and `onModelProgress` events are
// not a second source of row state. Tests therefore move rows the way production does - by
// publishing a new projection - and assert that progress events alone change nothing.
type ProgressListener = (progress: Record<string, unknown>) => void
type ProjectionListener = (projection: Record<string, unknown>) => void
let listeners: ProgressListener[] = []
let projectionListeners: ProjectionListener[] = []
let downloads: Array<Record<string, unknown>> = []
const publishProjection = (): void =>
  act(() => projectionListeners.forEach((listener) => listener(currentProjection())))
const retryDownload = vi.fn(
  async (): Promise<{ success: boolean; error?: string }> => ({ success: true })
)
const controlModel = vi.fn(async (intent: ModelControlIntent) => {
  if (intent.type === 'retry-download') {
    const result = await retryDownload()
    if (!result.success)
      return failed({ kind: 'runtime' as const, message: result.error ?? 'failed' })
  }
  const projection = currentProjection()
  projectionListeners.forEach((listener) => listener(projection))
  return ok({
    status: intent.type === 'cancel-download' ? ('cancelled' as const) : ('completed' as const),
    operationId: intent.operationId ?? 'test-operation',
    projection
  })
})
const catalogModels = [
  {
    id: 'Qwen/Qwen3.5-9B',
    name: 'Qwen 3.5 9B',
    kind: 'vision',
    org: 'Qwen',
    params: 9,
    artifacts: [
      { name: 'qwen.gguf', role: 'primary', sizeBytes: 6_000_000_000 },
      { name: 'mmproj.gguf', role: 'mmproj', sizeBytes: 700_000_000 }
    ]
  }
]

;(globalThis as unknown as { window: { api: unknown; confirm: () => boolean } }).window.api = {
  getStorageInfo: async () => ({
    dir: '/models',
    totalBytes: 0,
    freeBytes: 1_000_000_000,
    models: [],
    orphans: []
  }),
  listDownloads: async () => downloads,
  getDownloadRecoveryHealth: async () => ({ status: 'healthy' }),
  getModelControlProjection: async () => currentProjection(),
  onModelControlProjection: (next: ProjectionListener) => {
    projectionListeners.push(next)
    return () => {
      projectionListeners = projectionListeners.filter((listener) => listener !== next)
    }
  },
  controlModel,
  getModelVisionStatus: async () => ({}),
  onModelProgress: (next: ProgressListener) => {
    listeners.push(next)
    return () => {
      listeners = listeners.filter((listener) => listener !== next)
    }
  },
  systemHealth: async () => ({ ramGb: 32 }),
  deleteOrphans: async () => true,
  getCacheCleanupStatus: async () => null
}

let StoragePanel: () => React.JSX.Element
let ModelsScreen: typeof import('../ModelsScreen').ModelsScreen

// Dynamic imports are load-bearing: ModelsScreen reads `window.api` at module scope
// (ModelsScreen.tsx `const api = (window as any).api`), so the stub above must exist before that
// module evaluates. A static import would hoist above the stub and render with `api` undefined.
// The imports use the standard hook budget so a stalled component graph fails visibly.
beforeAll(async () => {
  StoragePanel = (await import('../setup/StoragePanel')).StoragePanel
  ModelsScreen = (await import('../ModelsScreen')).ModelsScreen
})

function currentProjection(): Record<string, unknown> {
  return {
    kinds: ['vision'],
    models: catalogModels,
    installed: [],
    activeIds: [],
    active: {
      text: { modelId: null, routeId: null, ready: false },
      image: { modelId: null, routeId: null, ready: false },
      speech: { modelId: null, routeId: null, ready: false },
      transcription: { modelId: null, routeId: null, ready: false },
      computer_use: { modelId: null, routeId: null, ready: false }
    },
    downloads,
    downloadDurability: { status: 'healthy' }
  }
}

beforeEach(() => {
  listeners = []
  projectionListeners = []
  downloads = []
  retryDownload.mockReset()
  retryDownload.mockResolvedValue({ success: true })
  controlModel.mockClear()
})

afterEach(cleanup)

describe('Models > Storage download rows', () => {
  it('keeps other job retries usable while one retries and another cancels through the real owner', async () => {
    const harness = await createRealDownloadControlHarness((projection) =>
      projectionListeners.forEach((listener) => listener(projection as Record<string, unknown>))
    )
    const { application, aborted } = harness
    const records = harness.records
    const oldControl = window.api.controlModel
    const oldProjection = window.api.getModelControlProjection
    window.api.controlModel = (intent) => application.models.control(intent)
    window.api.getModelControlProjection = async () => application.models.snapshot().control
    try {
      expect((await application.models.refresh()).ok).toBe(true)
      render(<StoragePanel />)
      const retryButton = async (model: string): Promise<HTMLElement> => {
        const label = await screen.findByText(model)
        const row = label.parentElement?.parentElement
        if (!row) throw new Error(`Missing row for ${model}`)
        return within(row).getByRole('button', { name: 'Retry' })
      }
      await userEvent.click(await retryButton('retry-model'))
      const secondRetry = await retryButton('retry-model-b')
      expect((secondRetry as HTMLButtonElement).disabled).toBe(false)
      await userEvent.click(secondRetry)
      await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))
      const cancel = await screen.findByRole('button', { name: 'Cancel retry-model-b' })
      expect((cancel as HTMLButtonElement).disabled).toBe(false)
      await userEvent.click(cancel)
      await waitFor(() => expect(aborted.size).toBe(1))
      expect((cancel as HTMLButtonElement).disabled).toBe(true)
      const thirdRetry = await retryButton('retry-model-c')
      expect((thirdRetry as HTMLButtonElement).disabled).toBe(false)
      await userEvent.click(thirdRetry)
      await act(async () => {
        harness.releaseTransfers()
      })
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Cancel retry-model-b' })).toBeNull()
      )
      // The row leaves the projection first; the durable cancel record lands after the queue settles.
      await waitFor(() =>
        expect(records().find((record) => record.manifest.id === 'retry-job-b')?.phase).toBe(
          'cancelled'
        )
      )
      expect(screen.getByRole('button', { name: 'Cancel retry-model' })).toBeTruthy()
      expect(await screen.findByRole('button', { name: 'Cancel retry-model-c' })).toBeTruthy()
      await userEvent.click(screen.getByRole('button', { name: 'Pause retry-model' }))
      const resume = await screen.findByRole('button', { name: 'Resume retry-model' })
      expect(records().find((record) => record.manifest.id === 'retry-job')?.phase).toBe('paused')
      expect(screen.getByRole('button', { name: 'Pause retry-model-c' })).toBeTruthy()
      await userEvent.click(resume)
      expect(await screen.findByRole('button', { name: 'Pause retry-model' })).toBeTruthy()
      expect(records().filter((record) => record.manifest.id === 'retry-job')).toHaveLength(1)
      expect(screen.queryByText(/could not|newer request/i)).toBeNull()
    } finally {
      cleanup()
      await harness.dispose()
      window.api.controlModel = oldControl
      window.api.getModelControlProjection = oldProjection
    }
  })

  it('shows and cancels a queued job when the canonical projection changes', async () => {
    render(<StoragePanel />)
    await screen.findByText('No models installed yet.')

    downloads = [
      {
        downloadId: 'queued:qwen',
        modelId: 'Qwen/Qwen3.5-9B',
        fileName: 'qwen.gguf',
        status: 'queued',
        bytesDownloaded: 0,
        totalBytes: 6_000_000_000
      }
    ]
    act(() => projectionListeners.forEach((listener) => listener(currentProjection())))

    expect(await screen.findByText('Queued')).toBeTruthy()
    expect(screen.getByText('Qwen/Qwen3.5-9B')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel Qwen/Qwen3.5-9B' }))
    expect(controlModel).toHaveBeenCalledWith({
      type: 'cancel-download',
      modelId: 'queued:qwen'
    })
  })

  it('targets the selected job for cancel, retry and dismiss when family labels match', async () => {
    downloads = [
      {
        downloadId: 'variant-a',
        modelId: 'same-family',
        status: 'downloading',
        bytesDownloaded: 10,
        totalBytes: 100
      },
      {
        downloadId: 'variant-b',
        modelId: 'same-family',
        status: 'downloading',
        bytesDownloaded: 20,
        totalBytes: 100
      },
      {
        downloadId: 'interrupted-c',
        modelId: 'same-family',
        status: 'interrupted',
        reason: 'prior run',
        bytesDownloaded: 0,
        totalBytes: 100
      }
    ]
    render(<StoragePanel />)
    const buttons = await screen.findAllByRole('button', { name: 'Cancel same-family' })
    const secondJobCancel = buttons[1]
    expect(secondJobCancel).toBeDefined()
    if (!secondJobCancel) throw new Error('The second job cancel button is missing')
    await userEvent.click(secondJobCancel)
    expect(controlModel).toHaveBeenLastCalledWith({ type: 'cancel-download', modelId: 'variant-b' })
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(controlModel).toHaveBeenLastCalledWith({
      type: 'retry-download',
      modelId: 'interrupted-c'
    })
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(controlModel).toHaveBeenLastCalledWith({
      type: 'clear-download',
      modelId: 'interrupted-c'
    })
  })

  it('keeps terminal registry truth, then allows a canonical retry of the same job', async () => {
    downloads = [
      {
        downloadId: 'job',
        modelId: 'same-model',
        status: 'downloading',
        bytesDownloaded: 10,
        totalBytes: 100
      }
    ]
    render(<StoragePanel />)
    await screen.findByRole('button', { name: 'Cancel same-model' })
    act(() =>
      listeners.forEach((listener) =>
        listener({
          downloadId: 'job',
          modelId: 'same-model',
          status: 'downloading',
          fileName: 'file.gguf',
          bytesDownloaded: 50,
          totalBytes: 100
        })
      )
    )
    // A bare progress event is not row state: the registry still says 10%.
    expect(screen.getByText('10%')).toBeTruthy()
    downloads = [{ ...downloads[0], status: 'interrupted', reason: 'stopped on disk' }]
    publishProjection()
    await screen.findByText('stopped on disk')
    expect(screen.queryByRole('button', { name: 'Cancel same-model' })).toBeNull()
    act(() =>
      listeners.forEach((listener) =>
        listener({
          downloadId: 'job',
          modelId: 'same-model',
          status: 'downloading',
          fileName: 'file.gguf',
          bytesDownloaded: 80,
          totalBytes: 100
        })
      )
    )
    expect(screen.queryByRole('button', { name: 'Cancel same-model' })).toBeNull()
    downloads = [{ ...downloads[0], status: 'downloading', bytesDownloaded: 60, reason: undefined }]
    publishProjection()
    expect(await screen.findByText('60%')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel same-model' })).toBeTruthy()
  })

  it('disables repeated cancel clicks and shows the settled cancelled state', async () => {
    downloads = [
      {
        downloadId: 'job',
        modelId: 'same-model',
        status: 'downloading',
        bytesDownloaded: 10,
        totalBytes: 100
      }
    ]
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    controlModel.mockImplementationOnce(async () => {
      await pending
      downloads = [{ ...downloads[0], status: 'cancelled' }]
      return ok({
        status: 'cancelled' as const,
        operationId: 'cancel',
        projection: currentProjection()
      })
    })
    render(<StoragePanel />)
    const cancel = await screen.findByRole('button', { name: 'Cancel same-model' })
    await userEvent.click(cancel)
    expect((cancel as HTMLButtonElement).disabled).toBe(true)
    await userEvent.click(cancel)
    expect(controlModel).toHaveBeenCalledTimes(1)
    await act(async () => {
      finish()
      await pending
    })
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Cancel same-model' })).toBeNull()
    )
    expect(screen.queryByText(/newer request/i)).toBeNull()
  })

  it('does not restore a running row from a projection read started before cancellation', async () => {
    downloads = [
      {
        downloadId: 'job',
        modelId: 'same-model',
        status: 'downloading',
        bytesDownloaded: 10,
        totalBytes: 100
      }
    ]
    // The only unsolicited projection read is the mount-time one. Hold it open while the pushed
    // stream and a cancel outcome move ahead of it, then let the stale answer land last.
    const stale = currentProjection()
    let release!: (value: never) => void
    const projection = vi.spyOn(window.api, 'getModelControlProjection')
    projection.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    try {
      render(<StoragePanel />)
      await waitFor(() => expect(release).toBeTypeOf('function'))
      publishProjection()
      await screen.findByRole('button', { name: 'Cancel same-model' })
      controlModel.mockImplementationOnce(async () => {
        downloads = [{ ...downloads[0], status: 'cancelled' }]
        return ok({
          status: 'cancelled' as const,
          operationId: 'cancel',
          projection: currentProjection()
        })
      })
      await userEvent.click(screen.getByRole('button', { name: 'Cancel same-model' }))
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Cancel same-model' })).toBeNull()
      )
      await act(async () => {
        release(stale as never)
      })
      expect(screen.queryByRole('button', { name: 'Cancel same-model' })).toBeNull()
    } finally {
      projection.mockRestore()
    }
  })

  it('keeps progress on its job and cannot reopen an interrupted older job for the same model', async () => {
    downloads = [
      {
        downloadId: 'old',
        modelId: 'same-model',
        status: 'interrupted',
        reason: 'old interrupted job',
        bytesDownloaded: 0,
        totalBytes: 100
      },
      {
        downloadId: 'current',
        modelId: 'same-model',
        status: 'downloading',
        bytesDownloaded: 10,
        totalBytes: 100
      }
    ]
    render(<StoragePanel />)
    await screen.findByText('old interrupted job')
    act(() =>
      listeners.forEach((listener) =>
        listener({
          downloadId: 'old',
          modelId: 'same-model',
          status: 'downloading',
          fileName: 'old.gguf',
          bytesDownloaded: 50,
          totalBytes: 100
        })
      )
    )
    expect(screen.getByText('10%')).toBeTruthy()
    downloads = downloads.map((download) =>
      download.downloadId === 'current' ? { ...download, bytesDownloaded: 50 } : download
    )
    publishProjection()
    expect(await screen.findByText('50%')).toBeTruthy()
    expect(screen.getByText('old interrupted job')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Cancel same-model' })).toHaveLength(1)
  })

  it('shows current, total, live rate, finite percentage, and cancel', async () => {
    downloads = [
      {
        downloadId: 'download:qwen',
        modelId: 'Qwen/Qwen3.5-9B',
        fileName: 'qwen.gguf',
        status: 'downloading',
        bytesDownloaded: 244_000_000,
        totalBytes: 703_000_000,
        bytesPerSecond: 2_800_000
      }
    ]
    const user = userEvent.setup()
    render(<StoragePanel />)

    expect(await screen.findByText('35%')).toBeTruthy()
    expect(screen.getByText(/244 MB of 703 MB/)).toBeTruthy()
    // Shared measures the rate and carries it in the projection; the row shows that value and
    // nothing derived in the renderer.
    expect(document.body.textContent).toContain(formatTransferSpeed(2_800_000))
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/)

    await user.click(screen.getByRole('button', { name: 'Cancel Qwen/Qwen3.5-9B' }))
    await waitFor(() =>
      expect(controlModel).toHaveBeenCalledWith({
        type: 'cancel-download',
        modelId: 'download:qwen'
      })
    )
  })

  it('states when total and rate are unavailable without inventing values', async () => {
    downloads = [
      {
        downloadId: 'download:unknown',
        modelId: 'image/unknown-size',
        fileName: 'unknown.bin',
        status: 'downloading',
        percent: Number.NaN,
        bytesDownloaded: Number.POSITIVE_INFINITY,
        totalBytes: 0,
        bytesPerSecond: Number.NaN
      }
    ]
    render(<StoragePanel />)

    expect(await screen.findByText('Downloading')).toBeTruthy()
    expect(screen.getByText(/0 bytes downloaded - Total size unavailable/)).toBeTruthy()
    expect(screen.getByText(/Rate unavailable/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/)
    expect(screen.getByRole('button', { name: 'Cancel image/unknown-size' })).toBeTruthy()
  })

  it('shows a typed retry failure instead of reporting the action as complete', async () => {
    downloads = [
      {
        downloadId: 'download:test',
        modelId: 'Qwen/Qwen3.5-9B',
        fileName: 'qwen.gguf',
        status: 'failed',
        bytesDownloaded: 0,
        totalBytes: 6_000_000_000,
        reason: 'network unavailable'
      }
    ]
    retryDownload.mockResolvedValue({ success: false, error: 'network still unavailable' })
    render(<StoragePanel />)

    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('network still unavailable')).toBeTruthy()
  })

  it('projects facade progress facts into the model browser', async () => {
    downloads = [
      {
        downloadId: 'download:qwen',
        modelId: 'Qwen/Qwen3.5-9B',
        fileName: 'qwen.gguf',
        status: 'queued',
        bytesDownloaded: 0,
        totalBytes: 6_000_000_000
      }
    ]
    render(<ModelsScreen navigationSubroute={null} />)
    await screen.findByText('Qwen 3.5 9B')
    expect(listeners).toHaveLength(1)

    const firstProgress = {
      downloadId: 'download:qwen',
      modelId: 'Qwen/Qwen3.5-9B',
      status: 'downloading',
      fileName: 'qwen.gguf',
      bytesDownloaded: 1_293_000_000,
      totalBytes: 6_000_000_000
    }
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    listeners.forEach((listener) => listener(firstProgress))
    clock.mockReturnValue(3_500)
    listeners.forEach((listener) => listener({ ...firstProgress, bytesDownloaded: 1_300_000_000 }))
    clock.mockRestore()

    expect(await screen.findByText('22%')).toBeTruthy()
    expect(screen.getByText(/1\.3 GB of 6\.0 GB/)).toBeTruthy()
    expect(screen.getByText(/2\.7 MB\/s/)).toBeTruthy()

    expect(document.body.textContent).not.toContain('Total size unavailable')
  })
})
