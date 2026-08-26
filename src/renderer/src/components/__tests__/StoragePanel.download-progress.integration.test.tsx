// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

type ProgressListener = (progress: Record<string, unknown>) => void
let listeners: ProgressListener[] = []
let downloads: Array<Record<string, unknown>> = []
const cancelModelDownload = vi.fn(async () => true)

;(globalThis as unknown as { window: { api: unknown; confirm: () => boolean } }).window.api = {
  getStorageInfo: async () => ({
    dir: '/models',
    totalBytes: 0,
    freeBytes: 1_000_000_000,
    models: [],
    orphans: []
  }),
  listDownloads: async () => downloads,
  onModelProgress: (next: ProgressListener) => {
    listeners.push(next)
    return () => {
      listeners = listeners.filter((listener) => listener !== next)
    }
  },
  systemHealth: async () => ({ ramGb: 32 }),
  getModelCatalog: async () => ({
    kinds: ['vision'],
    models: [
      {
        id: 'Qwen/Qwen3.5-9B',
        name: 'Qwen 3.5 9B',
        kind: 'vision',
        org: 'Qwen',
        params: 9,
        files: [
          { name: 'qwen.gguf', role: 'primary', sizeBytes: 6_000_000_000 },
          { name: 'mmproj.gguf', role: 'mmproj', sizeBytes: 700_000_000 }
        ]
      }
    ]
  }),
  getInstalledModels: async () => [],
  getModelVisionStatus: async () => ({}),
  getActiveModelIds: async () => [],
  estimateModelFit: async () => ({ level: 'ok' }),
  downloadModel: async () => ({ success: true }),
  cancelModelDownload,
  retryDownload: async () => true,
  clearDownload: async () => true,
  clearDownloads: async () => true,
  deleteModel: async () => true,
  deleteOrphans: async () => true,
  activateModel: async () => true,
  getCacheCleanupStatus: async () => null
}

let StoragePanel: () => React.JSX.Element
let ModelsScreen: () => React.JSX.Element

beforeAll(async () => {
  StoragePanel = (await import('../setup/StoragePanel')).StoragePanel
  ModelsScreen = (await import('../ModelsScreen')).ModelsScreen
})

beforeEach(() => {
  listeners = []
  downloads = []
  cancelModelDownload.mockClear()
})

afterEach(cleanup)

describe('Models > Storage download rows', () => {
  it('shows current, total, live rate, finite percentage, and cancel', async () => {
    downloads = [
      {
        modelId: 'Qwen/Qwen3.5-9B',
        status: 'downloading',
        downloadedBytes: 244_000_000,
        totalBytes: 703_000_000,
        bytesPerSecond: 2_800_000
      }
    ]
    const user = userEvent.setup()
    render(<StoragePanel />)

    expect(await screen.findByText('35%')).toBeTruthy()
    expect(screen.getByText(/244 MB of 703 MB/)).toBeTruthy()
    expect(screen.getByText(/2\.7 MB\/s/)).toBeTruthy()
    expect(screen.getByText(/~3 min left/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/)

    await user.click(screen.getByRole('button', { name: 'Cancel Qwen/Qwen3.5-9B' }))
    await waitFor(() => expect(cancelModelDownload).toHaveBeenCalledWith('Qwen/Qwen3.5-9B'))
  })

  it('states when total and rate are unavailable without inventing values', async () => {
    downloads = [
      {
        modelId: 'image/unknown-size',
        status: 'downloading',
        percent: Number.NaN,
        downloadedBytes: Number.POSITIVE_INFINITY,
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

  it('keeps Models and Storage on the same live multi-file job facts', async () => {
    downloads = [{ modelId: 'Qwen/Qwen3.5-9B', status: 'queued' }]
    render(
      <>
        <ModelsScreen />
        <StoragePanel />
      </>
    )
    await screen.findByText('Qwen 3.5 9B')

    const progress = {
      modelId: 'Qwen/Qwen3.5-9B',
      status: 'downloading',
      currentFile: 'qwen.gguf',
      fileIndex: 1,
      fileCount: 2,
      percent: 22,
      downloadedBytes: 1_300_000_000,
      totalBytes: 6_000_000_000,
      bytesPerSecond: 2_800_000
    }
    listeners.forEach((listener) => listener(progress))

    await waitFor(() => expect(screen.getAllByText('22%')).toHaveLength(2))
    // A reduced registry poll must not clobber the authoritative live event.
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(screen.getAllByText(/1\.3 GB of 6\.0 GB/)).toHaveLength(2))
    expect(screen.getAllByText(/2\.7 MB\/s/)).toHaveLength(2)
    expect(screen.getAllByText(/~30 min left/)).toHaveLength(2)
    expect(document.body.textContent).not.toContain('Total size unavailable')
  })
})
