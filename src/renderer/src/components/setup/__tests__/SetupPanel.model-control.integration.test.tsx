// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SetupPanel } from '../SetupPanel'
import { ok } from '@offgrid/application'

const setupPlan = vi.fn()
const setLlmSettings = vi.fn(async (settings: { performanceMode: string }) =>
  ok({ settings, changed: ['performanceMode'] })
)

beforeEach(() => {
  setupPlan.mockResolvedValue({
    mode: 'balanced',
    ramGb: 16,
    totalDownloadGb: 0,
    items: [
      {
        kind: 'chat',
        capability: 'Chat and vision',
        id: 'chat-local',
        name: 'Local Chat',
        sizeGb: 4.2,
        installed: true,
        required: true
      }
    ]
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      setupPlan,
      setLlmSettings,
      getLlmSettings: async () => ({ performanceMode: 'balanced' }),
      onSetupProgress: () => () => {},
      autoConfigure: async () => ({ success: true }),
      cancelModelDownload: async () => true
    }
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('rendered Desktop setup model journey', () => {
  it('shows setup bytes and honest missing total and rate while the run stays pending', async () => {
    let progress!: (value: {
      phase: string
      message: string
      downloadedBytes: number
      totalBytes?: number
      bytesPerSecond?: number
    }) => void
    let finish!: (value: unknown) => void
    Object.assign(window.api, {
      onSetupProgress: (listener: typeof progress) => {
        progress = listener
        return () => undefined
      },
      autoConfigure: () =>
        new Promise((resolve) => {
          finish = resolve
        })
    })
    render(<SetupPanel hideHealth />)
    try {
      await screen.findByText('Local Chat')
      await userEvent.click(screen.getByRole('button', { name: 'Configure' }))
      act(() =>
        progress({ phase: 'download', message: 'Downloading model', downloadedBytes: 2_000_000 })
      )
      expect(screen.getByText(/2 MB downloaded - Total size unavailable/)).toBeTruthy()
      expect(screen.getByText(/Rate unavailable/)).toBeTruthy()
      act(() =>
        progress({
          phase: 'download',
          message: 'Downloading model',
          downloadedBytes: 5_000_000,
          totalBytes: 10_000_000,
          bytesPerSecond: 1_048_576
        })
      )
      expect(screen.getByText(/50%.*5 MB of 10 MB.*1\.0 MB\/s/)).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
    } finally {
      await act(async () => {
        finish?.({ status: 'cancelled', success: false })
      })
    }
  })

  it('keeps resource selection and explains Mobile control without exposing credentials', async () => {
    const user = userEvent.setup()
    render(<SetupPanel hideHealth />)

    expect(await screen.findByText('Local and remote')).toBeTruthy()
    expect(screen.getByText('Control from Mobile')).toBeTruthy()
    expect(
      screen.getByText(/Installed models can handle Chat, images, transcription, voice/)
    ).toBeTruthy()
    expect(
      screen.getByText(/Choose this Desktop by name to see and switch its active models/)
    ).toBeTruthy()
    expect(screen.getByText(/Server API keys stay on this Desktop/)).toBeTruthy()
    expect(await screen.findByText('Local Chat')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Conservative' }))
    await waitFor(() =>
      expect(setLlmSettings).toHaveBeenCalledWith({ performanceMode: 'conservative' })
    )
    expect(setupPlan).toHaveBeenCalledWith('conservative')
  })
})
