// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteVisionSettingsTab } from '../RemoteVisionSettingsTab'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('<RemoteVisionSettingsTab/>', () => {
  it('tests and saves one remote vision configuration without exposing a stored key', async () => {
    const testRemoteVisionServer = vi.fn(async () => ({
      ok: true,
      latencyMs: 42,
      models: [
        { id: 'vision-model', name: 'Vision model' },
        { id: 'new-vision-model', name: 'New vision model' }
      ]
    }))
    const setRemoteVisionServer = vi.fn(async (update) => ({
      provider: update.provider,
      endpoint: update.endpoint,
      model: update.model,
      hasApiKey: true,
      activeServerId: update.serverId,
      servers: [
        {
          id: update.serverId,
          name: update.name,
          provider: update.provider,
          endpoint: update.endpoint,
          model: update.model,
          hasApiKey: true
        }
      ]
    }))
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      getRemoteVisionServer: vi.fn(async () => ({
        provider: 'custom',
        endpoint: 'https://models.example/v1',
        model: 'vision-model',
        hasApiKey: true,
        activeServerId: 'server-1',
        servers: [
          {
            id: 'server-1',
            name: 'Models example',
            provider: 'custom',
            endpoint: 'https://models.example/v1',
            model: 'vision-model',
            hasApiKey: true
          }
        ]
      })),
      testRemoteVisionServer,
      setRemoteVisionServer,
      removeRemoteVisionServer: vi.fn()
    }

    render(<RemoteVisionSettingsTab />)

    expect(await screen.findByDisplayValue('https://models.example/v1')).toBeTruthy()
    expect(screen.queryByText(/OpenRouter/i)).toBeNull()
    expect((screen.getByPlaceholderText(/stored key/i) as HTMLInputElement).value).toBe('')

    fireEvent.click(screen.getByRole('button', { name: 'Change model' }))
    await screen.findByText('Connected in 42 ms. 2 models found.')
    fireEvent.change(screen.getByPlaceholderText('Search models'), { target: { value: 'new' } })
    expect(screen.queryByText('Vision model')).toBeNull()
    fireEvent.click(screen.getByText('New vision model'))
    fireEvent.change(screen.getByLabelText('API key (optional)'), {
      target: { value: 'private-key' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(setRemoteVisionServer).toHaveBeenCalledWith({
        provider: 'custom',
        endpoint: 'https://models.example/v1',
        model: 'new-vision-model',
        name: 'Models example',
        serverId: 'server-1',
        apiKey: 'private-key'
      })
    )
    expect((screen.getByLabelText('API key (optional)') as HTMLInputElement).value).toBe('')
  })

  it('keeps local models active until the user enables a remote server', async () => {
    const setRemoteVisionServer = vi.fn(async () => ({
      provider: 'local',
      endpoint: '',
      model: '',
      hasApiKey: false,
      activeServerId: null,
      servers: []
    }))
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      getRemoteVisionServer: vi.fn(async () => ({
        provider: 'local',
        endpoint: '',
        model: '',
        hasApiKey: false,
        activeServerId: null,
        servers: []
      })),
      testRemoteVisionServer: vi.fn(),
      setRemoteVisionServer,
      removeRemoteVisionServer: vi.fn()
    }

    render(<RemoteVisionSettingsTab />)

    expect(await screen.findByText('Local model is active.')).toBeTruthy()
    expect(screen.queryByLabelText('Address')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(setRemoteVisionServer).toHaveBeenCalledWith({
        provider: 'local',
        endpoint: '',
        model: ''
      })
    )
  })
})
