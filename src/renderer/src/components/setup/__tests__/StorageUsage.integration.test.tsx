// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  failed,
  ok,
  type ModelControlIntent,
  type ModelControlProjection
} from '@offgrid/application'
import { DataPrivacyPanel } from '../DataPrivacyPanel'
import { StoragePanel } from '../StoragePanel'
import { modelControlSnapshot } from '../../__tests__/harness/model-control-snapshot'

describe('rendered storage usage', () => {
  let api: {
    getStorageInfo: ReturnType<typeof vi.fn>
    deleteOrphans: ReturnType<typeof vi.fn>
    getDataSummary: ReturnType<typeof vi.fn>
    onModelProgress: ReturnType<typeof vi.fn>
    getModelControlProjection: ReturnType<typeof vi.fn>
    onModelControlProjection: ReturnType<typeof vi.fn>
    controlModel: ReturnType<typeof vi.fn>
    clearAppCache: ReturnType<typeof vi.fn>
  }
  let projection: ModelControlProjection

  beforeEach(() => {
    projection = {
      ...modelControlSnapshot({
        kinds: ['text', 'vision'],
        models: [
          { id: 'text-model', name: 'Local text model', kind: 'text' as const, artifacts: [] },
          { id: 'vision-model', name: 'Local vision model', kind: 'vision' as const, artifacts: [] }
        ],
        installed: ['text-model', 'vision-model'],
        activeIds: ['text-model'],
        active: { text: 'text-model' }
      }),
      downloads: []
    }
    api = {
      getStorageInfo: vi.fn(async () => ({
        dir: '/tmp/offgrid/models',
        totalBytes: 1_500_000_000,
        freeBytes: 6_000_000_000,
        models: [
          {
            id: 'text-model',
            name: 'Local text model',
            kind: 'text',
            bytes: 1_250_000_000,
            active: true
          },
          {
            id: 'vision-model',
            name: 'Local vision model',
            kind: 'vision',
            bytes: 250_000_000,
            active: false
          }
        ],
        orphans: []
      })),
      deleteOrphans: vi.fn(async () => ({
        success: true,
        count: 0,
        freedBytes: 0,
        retainedBytes: 0,
        failures: []
      })),
      getDataSummary: vi.fn(async () => [
        {
          id: 'captures',
          label: 'Screen captures',
          detail: 'Captured frames and OCR',
          count: 120,
          bytes: 2_000_000
        },
        {
          id: 'images',
          label: 'Generated images & artifacts',
          detail: 'Images, artifacts, and thumbnails',
          count: 3,
          bytes: 8_000_000
        }
      ]),
      onModelProgress: vi.fn(() => () => {}),
      getModelControlProjection: vi.fn(async () => projection),
      onModelControlProjection: vi.fn(() => () => {}),
      controlModel: vi.fn(async (intent: ModelControlIntent) =>
        ok({
          status:
            intent.type === 'cancel-download' ? ('cancelled' as const) : ('completed' as const),
          operationId: 'test-operation',
          projection
        })
      ),
      clearAppCache: vi.fn(async () => ({ success: true, freedBytes: 3_000_000 }))
    }
    ;(globalThis as unknown as { window: Window }).window.api = api as never
  })

  afterEach(() => {
    cleanup()
  })

  it('shows model totals, per-model sizes, and artifact category usage', async () => {
    render(
      <>
        <StoragePanel />
        <DataPrivacyPanel />
      </>
    )

    expect(await screen.findByText('1.5 GB used by models')).toBeTruthy()
    expect(screen.getByText('6.0 GB free')).toBeTruthy()
    expect(screen.getByText('Local text model')).toBeTruthy()
    expect(screen.getByText('1.3 GB')).toBeTruthy()
    expect(screen.getByText('Local vision model')).toBeTruthy()
    expect(screen.getByText('250 MB')).toBeTruthy()

    expect(await screen.findByText('Screen captures')).toBeTruthy()
    expect(screen.getByText(/Captured frames and OCR.*120 items.*2 MB/)).toBeTruthy()
    expect(screen.getByText('Generated images & artifacts')).toBeTruthy()
    expect(screen.getByText(/Images, artifacts, and thumbnails.*3 items.*8 MB/)).toBeTruthy()
  })

  it('opens model settings only from the active installed model', async () => {
    const openSettings = vi.fn()
    window.addEventListener('og:open-model-settings-panel', openSettings)
    try {
      const user = userEvent.setup()
      render(<StoragePanel />)

      expect(
        await screen.findByRole('button', { name: 'Settings for Local text model' })
      ).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Settings for Local vision model' })).toBeNull()
      await user.click(screen.getByRole('button', { name: 'Settings for Local text model' }))

      expect(openSettings).toHaveBeenCalledOnce()
      expect((openSettings.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ tab: 'model' })
    } finally {
      window.removeEventListener('og:open-model-settings-panel', openSettings)
    }
  })

  it('uses the canonical model-control identity when the storage projection is stale', async () => {
    projection = {
      ...modelControlSnapshot({
        kinds: ['text', 'vision'],
        models: [
          { id: 'text-model', name: 'Local text model', kind: 'text' as const, artifacts: [] },
          { id: 'vision-model', name: 'Local vision model', kind: 'vision' as const, artifacts: [] }
        ],
        installed: ['text-model', 'vision-model'],
        activeIds: ['vision-model'],
        active: { text: 'vision-model' }
      }),
      downloads: []
    }

    render(<StoragePanel />)

    expect(
      await screen.findByRole('button', { name: 'Settings for Local vision model' })
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Settings for Local text model' })).toBeNull()
    expect(
      (screen.getByRole('button', { name: 'Delete Local vision model' }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
    expect(
      (
        screen.getByRole('button', {
          name: 'Delete Local text model'
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false)
  })

  it('requires explicit approval before it overrides the memory guard', async () => {
    api.controlModel.mockImplementation(async (intent: ModelControlIntent) => {
      if (intent.type === 'activate') {
        return ok({
          status: 'confirmation_required' as const,
          operationId: 'activate',
          confirmation: {
            confirmationId: 'approval',
            modelId: 'vision-model',
            surface: 'text' as const,
            message: 'This model can use more memory than is currently available.',
            advice: { level: 'challenger' as const, message: 'Memory pressure is possible.' },
            expiresAt: Date.now() + 60_000
          },
          projection
        })
      }
      return ok({ status: 'completed' as const, operationId: 'confirm', projection })
    })
    const user = userEvent.setup()
    render(<StoragePanel />)

    await user.click(await screen.findByRole('button', { name: 'Use' }))

    expect(
      screen.getByText('This model can use more memory than is currently available.')
    ).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Load anyway' }))
    expect(api.controlModel).toHaveBeenNthCalledWith(1, {
      type: 'activate',
      modelId: 'vision-model',
      surface: 'text'
    })
    expect(api.controlModel).toHaveBeenNthCalledWith(2, {
      type: 'confirm-activation',
      confirmationId: 'approval'
    })
  })

  it('shows an activation failure instead of refreshing as if it succeeded', async () => {
    api.controlModel.mockResolvedValue(
      failed({ kind: 'runtime', message: 'The runtime rejected this model.' })
    )
    const user = userEvent.setup()
    render(<StoragePanel />)

    await user.click(await screen.findByRole('button', { name: 'Use' }))

    expect((await screen.findByRole('alert')).textContent).toContain(
      'The runtime rejected this model.'
    )
  })

  it('explains a disk-full download and keeps its retry action reachable', async () => {
    // This is the public IPC payload. The producer's ENOSPC normalization and
    // persistence are exercised separately by model-integrity.integration.test.ts.
    const diskFullMessage = 'ENOSPC: no space left on device, write'
    projection = {
      ...projection,
      downloads: [
        {
          downloadId: 'disk-full',
          modelId: 'synthetic/text-model',
          fileName: 'model.gguf',
          status: 'failed',
          bytesDownloaded: 41,
          totalBytes: 100,
          startedAt: 1,
          reason: diskFullMessage
        }
      ]
    }
    const user = userEvent.setup()

    render(<StoragePanel />)

    expect(await screen.findByText('synthetic/text-model')).toBeTruthy()
    expect(screen.getByText(diskFullMessage)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(api.controlModel).toHaveBeenCalledWith({
      type: 'retry-download',
      modelId: 'disk-full'
    })
  })

  it('shows restart recovery risk and retained orphan files without false success', async () => {
    projection = {
      ...projection,
      downloadDurability: {
        status: 'degraded',
        reason: 'Download recovery data could not be saved.'
      }
    }
    api.getStorageInfo.mockResolvedValue({
      dir: '/tmp/offgrid/models',
      totalBytes: 1024,
      freeBytes: 6_000_000_000,
      models: [],
      orphans: [{ name: 'busy.gguf', bytes: 1024 }]
    })
    api.deleteOrphans.mockResolvedValue({
      success: false,
      count: 0,
      freedBytes: 0,
      retainedBytes: 1024,
      failures: [{ name: 'busy.gguf', bytes: 1024, error: 'File is busy.' }]
    })
    const user = userEvent.setup()

    render(<StoragePanel />)

    expect(
      await screen.findByText(
        'Current downloads can continue, but interrupted downloads cannot resume after restart.'
      )
    ).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Clean up' }))
    expect(await screen.findByText('busy.gguf could not be removed. 1 KB remains.')).toBeTruthy()
  })

  it('shows manager-owned running and queued counts and can cancel a queued item (#22)', async () => {
    projection = {
      ...projection,
      downloads: [
        ['model-running-1', 'downloading', 15],
        ['model-running-2', 'downloading', 30],
        ['model-running-3', 'downloading', 45],
        ['model-queued-1', 'queued', 0],
        ['model-queued-2', 'queued', 0]
      ].map(([downloadId, status, bytesDownloaded]) => ({
        downloadId: downloadId as string,
        modelId: downloadId as string,
        fileName: 'model.gguf',
        status: status as 'downloading' | 'queued',
        bytesDownloaded: bytesDownloaded as number,
        totalBytes: 100,
        startedAt: 1
      }))
    }
    const user = userEvent.setup()

    render(<StoragePanel />)

    expect(await screen.findByText('3 running · 2 queued')).toBeTruthy()
    expect(screen.getAllByText('Queued')).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: 'Cancel model-queued-2' }))
    expect(api.controlModel).toHaveBeenCalledWith({
      type: 'cancel-download',
      modelId: 'model-queued-2'
    })
  })

  it('clears only temporary cache and explains which durable stores remain (#134)', async () => {
    const user = userEvent.setup()
    render(<StoragePanel />)

    expect(await screen.findByText('Temporary app cache')).toBeTruthy()
    expect(
      screen.getByText(
        'Safe to clear. Chats, projects, models, vault, settings, and Pro access stay.'
      )
    ).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Clear cache' }))

    expect(api.clearAppCache).toHaveBeenCalledTimes(1)
    expect((await screen.findByRole('status')).textContent).toBe(
      'Temporary cache cleared. 3 MB reclaimed. Your data and models were kept.'
    )
  })

  it('does not claim success when the cache boundary fails', async () => {
    api.clearAppCache.mockRejectedValue(new Error('cache clear failed'))
    const user = userEvent.setup()
    render(<StoragePanel />)

    await user.click(await screen.findByRole('button', { name: 'Clear cache' }))

    expect((await screen.findByRole('status')).textContent).toBe(
      'Cache could not be cleared. Your data and models were not changed.'
    )
  })

  it('reports successful cleanup when Electron cannot measure reclaimed bytes', async () => {
    api.clearAppCache.mockResolvedValue({ success: true, freedBytes: null })
    const user = userEvent.setup()
    render(<StoragePanel />)

    await user.click(await screen.findByRole('button', { name: 'Clear cache' }))

    expect((await screen.findByRole('status')).textContent).toBe(
      'Temporary cache cleared. Your data and models were kept.'
    )
  })
})
