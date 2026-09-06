// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsPanel } from '../SettingsPanel'
import { preloadCapabilityFakes } from './harness/chat-boundary'
import { modelControlBoundary } from './harness/model-control-snapshot'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('<SettingsPanel/> image settings', () => {
  it('opens on the active image model and persists the same image preferences Chat uses', async () => {
    const saveSetting = vi.fn(async () => undefined)
    const modelControl = modelControlBoundary({
      kinds: ['image'],
      models: [
        { id: 'dreamshaper-xl-v2-turbo.gguf' },
        { id: 'juggernaut-xl-v9.gguf' }
      ],
      installed: ['dreamshaper-xl-v2-turbo.gguf', 'juggernaut-xl-v9.gguf'],
      active: { image: 'dreamshaper-xl-v2-turbo.gguf' }
    })
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      ...preloadCapabilityFakes(),
      ...modelControl,
      getLlmSettings: async () => ({}),
      getModelCatalog: async () => ({ models: [] }),
      getActiveModel: async () => null,
      imageGenStatus: async () => ({
        available: true,
        active: 'dreamshaper-xl-v2-turbo.gguf',
        defaultModel: 'dreamshaper-xl-v2-turbo.gguf',
        models: ['dreamshaper-xl-v2-turbo.gguf', 'juggernaut-xl-v9.gguf']
      }),
      getSettings: async () => ({
        imageParams: {
          'dreamshaper-xl-v2-turbo.gguf': { size: 768, steps: 12, cfgScale: 3 }
        },
        imgSeed: '42',
        imgNegative: 'blurry',
        enhanceImagePrompts: true
      }),
      saveSetting,
      ttsVoices: async () => [],
      prepareTtsVoice: async () => ({ ready: true }),
      onTtsVoiceProgress: () => () => {},
      listTools: async () => [],
      mcpList: async () => []
    }

    const view = render(<SettingsPanel embedded initialTab="image" onClose={() => {}} />)
    expect(view.container.querySelector('select')).toBeNull()

    const user = userEvent.setup()
    const model = await screen.findByRole('button', { name: 'Active image model' })
    expect(model.textContent).toContain('dreamshaper-xl-v2-turbo')
    expect(
      (screen.getByRole('spinbutton', { name: 'Image steps' }) as HTMLInputElement).value
    ).toBe('12')
    expect(screen.getByRole('button', { name: 'Image size' }).textContent).toContain('768 × 768')

    await user.click(screen.getByRole('button', { name: 'Image size' }))
    await user.click(screen.getByRole('menuitemradio', { name: '1024 × 1024' }))
    await waitFor(() =>
      expect(saveSetting).toHaveBeenCalledWith(
        'imageParams',
        expect.objectContaining({
          'dreamshaper-xl-v2-turbo.gguf': expect.objectContaining({ size: 1024 })
        })
      )
    )

    const guidance = screen.getByRole('spinbutton', { name: 'Image guidance' })
    fireEvent.change(guidance, {
      target: { value: '4' }
    })
    fireEvent.blur(guidance)
    await waitFor(() =>
      expect(saveSetting).toHaveBeenCalledWith(
        'imageParams',
        expect.objectContaining({
          'dreamshaper-xl-v2-turbo.gguf': expect.objectContaining({ cfgScale: 4 })
        })
      )
    )

    await user.click(model)
    await user.click(screen.getByRole('menuitemradio', { name: 'juggernaut-xl-v9' }))
    expect(modelControl.projection().active.image.modelId).toBe('juggernaut-xl-v9.gguf')
  })
})
