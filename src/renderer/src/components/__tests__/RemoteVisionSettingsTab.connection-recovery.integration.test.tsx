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
      provider: 'local',
      endpoint: '',
      model: '',
      hasApiKey: false,
      activeServerId: null,
      servers: []
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
    setRemoteVisionServer: async () => undefined,
    removeRemoteVisionServer: async () => undefined
  }
}

afterEach(cleanup)

describe('<RemoteVisionSettingsTab/> connection recovery', () => {
  it('keeps the server editable after failure and shows its model after retry', async () => {
    const boundary = new RemoteServerBoundary()
    Object.defineProperty(window, 'api', { configurable: true, value: boundary.api })
    const user = userEvent.setup()
    render(<RemoteVisionSettingsTab />)

    await user.click(await screen.findByRole('button', { name: 'Add server' }))
    await user.type(screen.getByLabelText('Server name'), 'Studio server')
    await user.type(screen.getByLabelText('Address'), 'https://models.studio.test')
    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    expect(await screen.findByText('The model server is still starting.')).toBeTruthy()
    expect(screen.getByDisplayValue('https://models.studio.test')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    expect(await screen.findByText('Connected in 18 ms. 1 model found.')).toBeTruthy()
    expect((screen.getByLabelText('Text and vision') as HTMLInputElement).value).toBe(
      'local/vision-7b'
    )
    expect(screen.getByText('Vision 7B')).toBeTruthy()
  })
})
