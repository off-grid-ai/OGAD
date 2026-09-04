// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { failed, ok, type ModelControlIntent } from '@offgrid/application'

type ProgressListener = (progress: Record<string, unknown>) => void
let listeners: ProgressListener[] = []
let downloads: Array<Record<string, unknown>> = []
const retryDownload = vi.fn(
  async (): Promise<{ success: boolean; error?: string }> => ({ success: true })
)
const controlModel = vi.fn(async (intent: ModelControlIntent) => {
  if (intent.type === 'retry-download') {
    const result = await retryDownload()
    if (!result.success) return failed({ kind: 'runtime' as const, message: result.error ?? 'failed' })
  }
  return ok({
    status: intent.type === 'cancel-download' ? ('cancelled' as const) : ('completed' as const),
    operationId: 'test-operation',
    projection: currentProjection()
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

let StoragePanel: () => React.JSX.Element
let ModelsScreen: typeof import('../ModelsScreen').ModelsScreen

beforeAll(async () => {
  StoragePanel = (await import('../setup/StoragePanel')).StoragePanel
  ModelsScreen = (await import('../ModelsScreen')).ModelsScreen
})

beforeEach(() => {
  listeners = []
  downloads = []
  retryDownload.mockReset()
  retryDownload.mockResolvedValue({ success: true })
  controlModel.mockClear()
})

afterEach(cleanup)

describe('Models > Storage download rows', () => {
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
    expect(document.body.textContent).not.toContain('/s')
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/)

    await user.click(screen.getByRole('button', { name: 'Cancel Qwen/Qwen3.5-9B' }))
    await waitFor(() =>
      expect(controlModel).toHaveBeenCalledWith({
        type: 'cancel-download',
        modelId: 'Qwen/Qwen3.5-9B'
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
    expect(screen.getByText('Total size unavailable')).toBeTruthy()
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
