// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsPanel } from '../SettingsPanel'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('<SettingsPanel/> image settings', () => {
  it('opens on the active image model and persists the same image preferences Chat uses', async () => {
    const saveSetting = vi.fn(async () => undefined)
    const setActiveModalModel = vi.fn(async () => undefined)
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      getLlmSettings: async () => ({}),
      getModelCatalog: async () => ({ models: [] }),
      getActiveModel: async () => null,
      imageGenStatus: async () => ({
        available: true,
        active: 'dreamshaper-xl-v2-turbo.gguf',
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
      setActiveModalModel,
      ttsVoices: async () => [],
      listTools: async () => [],
      mcpList: async () => []
    }

    render(<SettingsPanel embedded initialTab="image" onClose={() => {}} />)

    const model = await screen.findByRole('combobox', { name: 'Active image model' })
    expect((model as HTMLSelectElement).value).toBe('dreamshaper-xl-v2-turbo.gguf')
    expect(
      (screen.getByRole('spinbutton', { name: 'Image steps' }) as HTMLInputElement).value
    ).toBe('12')
    expect((screen.getByRole('combobox', { name: 'Image size' }) as HTMLSelectElement).value).toBe(
      '768'
    )

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Image guidance' }), {
      target: { value: '4' }
    })
    await waitFor(() =>
      expect(saveSetting).toHaveBeenCalledWith(
        'imageParams',
        expect.objectContaining({
          'dreamshaper-xl-v2-turbo.gguf': expect.objectContaining({ cfgScale: 4 })
        })
      )
    )

    fireEvent.change(model, { target: { value: 'juggernaut-xl-v9.gguf' } })
    expect(setActiveModalModel).toHaveBeenCalledWith('image', 'juggernaut-xl-v9.gguf')
  })
})
