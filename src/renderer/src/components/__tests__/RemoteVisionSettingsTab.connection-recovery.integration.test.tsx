// @vitest-environment jsdom

/**
 * Remote model-server recovery through the real settings tab. The Electron server bridge is the
 * only fake boundary; endpoint normalization, provider selection, and the rendered state machine
 * remain production code.
 */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { RemoteVisionSettingsTab } from '../RemoteVisionSettingsTab'

class RemoteServerBoundary {
  private attempts = 0

  readonly api = {
    getRemoteVisionServer: async () => ({
      provider: 'ollama',
      endpoint: 'https://models.studio.test/v1',
      model: 'legacy/vision',
      hasApiKey: false,
      activeServerId: 'studio',
      servers: [
        {
          id: 'studio',
          name: 'Studio server',
          provider: 'ollama',
          endpoint: 'https://models.studio.test/v1',
          model: 'legacy/vision',
          selections: { text: 'legacy/vision' },
          catalog: { text: [{ id: 'legacy/vision', name: 'Legacy Vision' }] },
          hasApiKey: false,
          screenFramesAllowed: false
        }
      ]
    }),
    testRemoteVisionServer: async () => {
      this.attempts += 1
      if (this.attempts === 1) {
        return { ok: false, error: 'The model server is still starting.' }
      }
      return {
        ok: true,
        latencyMs: 18,
        models: [{ id: 'local/vision-7b', name: 'Vision 7B', modality: 'text' }],
        catalog: { text: [{ id: 'local/vision-7b', name: 'Vision 7B' }] },
        selections: { text: 'local/vision-7b' }
      }
    },
    setRemoteVisionServer: async () => ({
      provider: 'ollama',
      endpoint: 'https://models.studio.test/v1',
      model: 'local/vision-7b',
      hasApiKey: false,
      activeServerId: 'studio',
      servers: [
        {
          id: 'studio',
          name: 'Studio server',
          provider: 'ollama',
          endpoint: 'https://models.studio.test/v1',
          model: 'local/vision-7b',
          selections: { text: 'local/vision-7b' },
          catalog: { text: [{ id: 'local/vision-7b', name: 'Vision 7B' }] },
          hasApiKey: false,
          screenFramesAllowed: false
        }
      ]
    }),
    removeRemoteVisionServer: async () => undefined
  }
}

afterEach(cleanup)

describe('<RemoteVisionSettingsTab/> connection recovery', () => {
  it('clears stale models after failure and saves working capability after retry', async () => {
    const boundary = new RemoteServerBoundary()
    Object.defineProperty(window, 'api', { configurable: true, value: boundary.api })
    const user = userEvent.setup()
    render(<RemoteVisionSettingsTab />)

    expect(((await screen.findByLabelText('Text and vision')) as HTMLInputElement).value).toBe(
      'legacy/vision'
    )
    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    expect(await screen.findByText('The model server is still starting.')).toBeTruthy()
    expect(screen.queryByLabelText('Text and vision')).toBeNull()
    expect(screen.queryByText('Legacy Vision')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    expect(await screen.findByText('Connected in 18 ms. 1 model found.')).toBeTruthy()
    expect((screen.getByLabelText('Text and vision') as HTMLInputElement).value).toBe(
      'local/vision-7b'
    )
    expect(screen.getByText('Vision 7B')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Server saved and active.')).toBeTruthy()
    expect((screen.getByLabelText('Text and vision') as HTMLInputElement).value).toBe(
      'local/vision-7b'
    )
  })
})
