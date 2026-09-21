// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteVisionSettingsTab } from '../RemoteVisionSettingsTab'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('<RemoteVisionSettingsTab/>', () => {
  it('saves a media-only server and turns every remote modality off', async () => {
    let saved = {
      provider: 'local' as 'local' | 'openrouter',
      endpoint: '',
      model: '',
      hasApiKey: false,
      activeServerId: null as string | null,
      servers: [] as Array<Record<string, unknown>>
    }
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      getRemoteVisionServer: async () => saved,
      testRemoteVisionServer: async () => ({
        ok: true,
        latencyMs: 12,
        models: [
          { id: 'image-maker', name: 'Image Maker', kind: 'image' },
          { id: 'listener', name: 'Listener', kind: 'transcription' },
          { id: 'speaker', name: 'Speaker', kind: 'voice' }
        ]
      }),
      setRemoteVisionServer: async (update: {
        provider: 'local' | 'openrouter'
        endpoint: string
        model: string
        name?: string
        mediaModels?: Record<string, string>
        modelCatalog?: unknown[]
      }) => {
        saved =
          update.provider === 'local'
            ? {
                ...saved,
                provider: 'local',
                activeServerId: null,
                servers: saved.servers.map((server) => ({ ...server, enabled: false }))
              }
            : {
                provider: 'openrouter',
                endpoint: update.endpoint,
                model: update.model,
                hasApiKey: false,
                activeServerId: 'media-server',
                servers: [
                  {
                    id: 'media-server',
                    name: update.name,
                    provider: update.provider,
                    endpoint: update.endpoint,
                    model: update.model,
                    mediaModels: update.mediaModels,
                    modelCatalog: update.modelCatalog,
                    enabled: true,
                    hasApiKey: false,
                    screenFramesAllowed: false
                  }
                ]
              }
        return saved
      },
      removeRemoteVisionServer: async () => saved
    }

    render(<RemoteVisionSettingsTab />)
    await screen.findByText('Local model is active.')
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    fireEvent.change(screen.getByLabelText('Server name'), { target: { value: 'Media provider' } })
    fireEvent.change(screen.getByLabelText('Address'), {
      target: { value: 'https://openrouter.ai/api/v1' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByText('Connected in 12 ms. 3 models found.')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'image model' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'Image Maker' }))
    await user.click(screen.getByRole('button', { name: 'transcription model' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'Listener' }))
    await user.click(screen.getByRole('button', { name: 'voice model' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'Speaker' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Server saved and active.')
    cleanup()
    render(<RemoteVisionSettingsTab />)
    await screen.findByDisplayValue('Media provider')
    expect(screen.getByRole('button', { name: 'image model' }).textContent).toContain('Image Maker')
    expect(screen.getByRole('button', { name: 'transcription model' }).textContent).toContain(
      'Listener'
    )
    expect(screen.getByRole('button', { name: 'voice model' }).textContent).toContain('Speaker')

    fireEvent.click(screen.getByRole('switch', { name: 'Use remote server' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Local model is active.')
    expect(
      screen.getByRole('switch', { name: 'Use remote server' }).getAttribute('aria-checked')
    ).toBe('false')
  })

  it('tests and saves one remote vision configuration without exposing a stored key', async () => {
    const testRemoteVisionServer = vi.fn(async () => ({
      ok: true,
      latencyMs: 42,
      models: [
        { id: 'vision-model', name: 'Vision model', kind: 'text' },
        { id: 'new-vision-model', name: 'New vision model', kind: 'text' }
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
          hasApiKey: true,
          screenFramesAllowed: update.screenFramesAllowed
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
            hasApiKey: true,
            screenFramesAllowed: false
          }
        ]
      })),
      testRemoteVisionServer,
      setRemoteVisionServer,
      removeRemoteVisionServer: vi.fn()
    }

    render(<RemoteVisionSettingsTab />)

    expect(await screen.findByDisplayValue('https://models.example/v1')).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Remote server details' }).className).toContain(
      'lg:grid-cols-2'
    )
    expect(screen.queryByText(/OpenRouter/i)).toBeNull()
    expect((screen.getByPlaceholderText(/stored key/i) as HTMLInputElement).value).toBe('')
    expect(screen.getByText(/Blocked until you allow it/i).textContent).toBe(
      'Blocked until you allow it. Web Use and Computer Use can send screen images with visible text, apps, and other content to this server.'
    )

    fireEvent.click(screen.getByRole('button', { name: 'Change model' }))
    await screen.findByText('Connected in 42 ms. 2 models found.')
    fireEvent.change(screen.getByPlaceholderText('Search models'), { target: { value: 'new' } })
    expect(screen.queryByText('Vision model')).toBeNull()
    fireEvent.click(screen.getByText('New vision model'))
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'grounding model' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'New vision model' }))
    await user.click(screen.getByRole('button', { name: 'decision model' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'Vision model' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Allow screen images' }))
    expect(
      screen.getByText(/can send screen images with visible text, apps, and other content/i)
        .textContent
    ).toBe(
      'Allowed after Save. Web Use and Computer Use can send screen images with visible text, apps, and other content to Models example at models.example.'
    )
    fireEvent.change(screen.getByLabelText('API key (optional)'), {
      target: { value: 'private-key' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(setRemoteVisionServer).toHaveBeenCalledWith({
        provider: 'custom',
        endpoint: 'https://models.example/v1',
        model: 'new-vision-model',
        mediaModels: { text: 'new-vision-model' },
        roleModels: {
          grounding: 'new-vision-model',
          decision: 'vision-model'
        },
        modelCatalog: [
          { id: 'vision-model', name: 'Vision model', kind: 'text' },
          { id: 'new-vision-model', name: 'New vision model', kind: 'text' }
        ],
        name: 'Models example',
        serverId: 'server-1',
        apiKey: 'private-key',
        screenFramesAllowed: true
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

    fireEvent.click(screen.getByRole('switch', { name: 'Use remote server' }))
    expect(screen.getByPlaceholderText('https://models.example')).toBeTruthy()
  })
})
