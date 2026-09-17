// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingsPanel } from '../SettingsPanel'

afterEach(() => {
  cleanup()
})

describe('<SettingsPanel/> image settings', () => {
  it('opens on the active image model and persists the same image preferences Chat uses', async () => {
    const saved: Array<[string, unknown]> = []
    const selectedModels: Array<[string, string]> = []
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
      saveSetting: async (key: string, value: unknown) => {
        saved.push([key, value])
      },
      setActiveModalModel: async (kind: string, modelId: string) => {
        selectedModels.push([kind, modelId])
      },
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
      expect(saved).toContainEqual([
        'imageParams',
        expect.objectContaining({
          'dreamshaper-xl-v2-turbo.gguf': expect.objectContaining({ size: 1024 })
        })
      ])
    )

    const savesBeforeGuidance = saved.length
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Image guidance' }), {
      target: { value: '4' }
    })
    expect(saved).toHaveLength(savesBeforeGuidance)
    fireEvent.blur(screen.getByRole('spinbutton', { name: 'Image guidance' }))
    await waitFor(() =>
      expect(saved).toContainEqual([
        'imageParams',
        expect.objectContaining({
          'dreamshaper-xl-v2-turbo.gguf': expect.objectContaining({ cfgScale: 4 })
        })
      ])
    )

    await user.click(model)
    await user.click(screen.getByRole('menuitemradio', { name: 'juggernaut-xl-v9' }))
    expect(selectedModels).toContainEqual(['image', 'juggernaut-xl-v9.gguf'])
  })

  it('keeps Steps and Guidance editable and restores them when Image settings reopens', async () => {
    const settings: Record<string, unknown> = {
      imageParams: { 'dreamshaper-xl-v2-turbo.gguf': { size: 512, steps: 12, cfgScale: 3 } }
    }
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      getLlmSettings: async () => ({}),
      getModelCatalog: async () => ({ models: [] }),
      getActiveModel: async () => null,
      imageGenStatus: async () => ({
        available: true,
        active: 'dreamshaper-xl-v2-turbo.gguf',
        models: ['dreamshaper-xl-v2-turbo.gguf']
      }),
      getSettings: async () => settings,
      saveSetting: async (key: string, value: unknown) => {
        settings[key] = value
      },
      ttsVoices: async () => [],
      prepareTtsVoice: async () => ({ ready: true }),
      onTtsVoiceProgress: () => () => {},
      listTools: async () => [],
      mcpList: async () => []
    }
    const user = userEvent.setup()
    const panel = render(<SettingsPanel embedded initialTab="image" onClose={() => {}} />)
    const steps = await screen.findByRole('spinbutton', { name: 'Image steps' })

    await user.clear(steps)
    await user.type(steps, '45')
    expect((steps as HTMLInputElement).value).toBe('45')
    await user.tab()

    const guidance = screen.getByRole('spinbutton', { name: 'Image guidance' })
    await user.clear(guidance)
    await user.type(guidance, '1.5')
    expect((guidance as HTMLInputElement).value).toBe('1.5')
    await user.tab()

    panel.unmount()
    render(<SettingsPanel embedded initialTab="image" onClose={() => {}} />)
    await waitFor(() =>
      expect(
        (screen.getByRole('spinbutton', { name: 'Image steps' }) as HTMLInputElement).value
      ).toBe('45')
    )
    expect(
      (screen.getByRole('spinbutton', { name: 'Image guidance' }) as HTMLInputElement).value
    ).toBe('1.5')
  })
})
