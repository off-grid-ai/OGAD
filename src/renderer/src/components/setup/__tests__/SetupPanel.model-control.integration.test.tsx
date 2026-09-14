// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SetupPanel } from '../SetupPanel'

let savedMode: 'balanced' | 'conservative' | 'extreme'
let failNextSave: boolean
let requestedPlanMode: string | undefined

beforeEach(() => {
  savedMode = 'balanced'
  failNextSave = false
  requestedPlanMode = undefined
  // The Electron preload bridge is the external boundary. The Setup panel stays real.
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      setupPlan: async (mode: string) => {
        requestedPlanMode = mode
        return {
          mode, ramGb: 16, totalDownloadGb: 0,
          items: [{ kind: 'chat', capability: 'Chat and vision', id: 'chat-local',
            name: 'Local Chat', sizeGb: 4.2, installed: true, required: true }]
        }
      },
      setLlmSettings: async (value: { performanceMode: typeof savedMode }) => {
        if (failNextSave) {
          failNextSave = false
          throw new Error('Settings could not be saved')
        }
        savedMode = value.performanceMode
      },
      getLlmSettings: async () => ({ performanceMode: savedMode }),
      onSetupProgress: () => () => {},
      autoConfigure: async () => ({ success: true }),
      cancelModelDownload: async () => true
    }
  })
})

afterEach(() => cleanup())

describe('rendered Desktop setup model journey', () => {
  it('keeps the resource choice and model plan on a failed save, then accepts a successful save', async () => {
    const user = userEvent.setup()
    render(<SetupPanel hideHealth />)
    expect(await screen.findByText('Local Chat')).toBeTruthy()
    expect(screen.getByText('Control from Mobile')).toBeTruthy()
    expect(screen.getByText(/Installed models can handle Chat, images, transcription, voice/)).toBeTruthy()
    expect(screen.getByText(/Server API keys stay on this Desktop/)).toBeTruthy()

    failNextSave = true
    await user.click(screen.getByRole('button', { name: 'Conservative' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Balanced' }).getAttribute('aria-pressed')).toBe('true'))
    expect(savedMode).toBe('balanced')
    expect(requestedPlanMode).toBe('balanced')

    await user.click(screen.getByRole('button', { name: 'Conservative' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Conservative' }).getAttribute('aria-pressed')).toBe('true'))
    expect(savedMode).toBe('conservative')
    expect(requestedPlanMode).toBe('conservative')
  })
})
