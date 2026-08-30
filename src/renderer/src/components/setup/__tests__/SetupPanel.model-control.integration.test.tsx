// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SetupPanel } from '../SetupPanel'

const setupPlan = vi.fn()
const setLlmSettings = vi.fn(async () => undefined)

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
