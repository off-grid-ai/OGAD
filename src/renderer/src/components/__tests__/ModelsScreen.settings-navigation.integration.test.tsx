// @vitest-environment jsdom

/**
 * The installed-model Settings action through the real Models screen and the real
 * app navigation event contract. Electron/model I/O stays at the window.api
 * boundary; the card grouping, installed/active projections, and user click are real.
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const ACTIVE_ID = 'offgrid/active-model'
const ACTIVE_IMAGE_ID = 'offgrid/active-image-model'
const ACTIVE_VOICE_ID = 'offgrid/active-voice-model'
const ACTIVE_TRANSCRIPTION_ID = 'offgrid/active-transcription-model'
const INSTALLED_ID = 'offgrid/installed-model'
const AVAILABLE_ID = 'offgrid/available-model'

const MODELS = [
  {
    id: ACTIVE_ID,
    name: 'Active Model',
    kind: 'text',
    files: [{ name: 'active.gguf', url: 'https://example.test/active.gguf', sizeBytes: 2e9 }]
  },
  {
    id: INSTALLED_ID,
    name: 'Installed Model',
    kind: 'text',
    files: [{ name: 'installed.gguf', url: 'https://example.test/installed.gguf', sizeBytes: 2e9 }]
  },
  {
    id: AVAILABLE_ID,
    name: 'Available Model',
    kind: 'text',
    files: [{ name: 'available.gguf', url: 'https://example.test/available.gguf', sizeBytes: 2e9 }]
  },
  {
    id: ACTIVE_IMAGE_ID,
    name: 'Active Image Model',
    kind: 'image',
    files: [{ name: 'image.gguf', url: 'https://example.test/image.gguf', sizeBytes: 2e9 }]
  },
  {
    id: ACTIVE_VOICE_ID,
    name: 'Active Voice Model',
    kind: 'voice',
    files: [{ name: 'voice.gguf', url: 'https://example.test/voice.gguf', sizeBytes: 2e9 }]
  },
  {
    id: ACTIVE_TRANSCRIPTION_ID,
    name: 'Active Transcription Model',
    kind: 'transcription',
    files: [{ name: 'stt.gguf', url: 'https://example.test/stt.gguf', sizeBytes: 2e9 }]
  }
]

const activateModel = vi.fn(async () => ({ success: true }))

;(window as unknown as { api: unknown }).api = {
  systemHealth: async () => ({ ramGb: 32 }),
  getModelCatalog: async () => ({
    kinds: ['text', 'image', 'voice', 'transcription'],
    models: MODELS
  }),
  getInstalledModels: async () => [
    ACTIVE_ID,
    INSTALLED_ID,
    ACTIVE_IMAGE_ID,
    ACTIVE_VOICE_ID,
    ACTIVE_TRANSCRIPTION_ID
  ],
  getActiveModelIds: async () => [
    ACTIVE_ID,
    ACTIVE_IMAGE_ID,
    ACTIVE_VOICE_ID,
    ACTIVE_TRANSCRIPTION_ID
  ],
  getModelVisionStatus: async () => ({}),
  onModelProgress: () => () => {},
  searchModels: async () => [],
  estimateModelFit: async () => ({ level: 'ok', message: '' }),
  activateModel
}

let ModelsScreen: () => React.JSX.Element

beforeAll(async () => {
  ModelsScreen = (await import('../ModelsScreen')).ModelsScreen
})

beforeEach(() => {
  activateModel.mockClear()
})

afterEach(cleanup)

const cardFor = (name: string): HTMLElement =>
  screen.getByRole('button', { name }).closest('[role="listitem"]') as HTMLElement

describe('<ModelsScreen/> active model settings', () => {
  it('offers Settings only on the active card', async () => {
    render(<ModelsScreen />)
    expect(await screen.findAllByRole('button', { name: 'Open model settings' })).toHaveLength(1)

    expect(
      within(cardFor('Active Model')).getByRole('button', { name: 'Open model settings' })
    ).toBeTruthy()
    expect(
      within(cardFor('Installed Model')).queryByRole('button', { name: 'Open model settings' })
    ).toBeNull()
    expect(
      within(cardFor('Available Model')).queryByRole('button', { name: 'Open model settings' })
    ).toBeNull()
  })

  it('opens the shared model-settings drawer without activating the card model', async () => {
    const user = userEvent.setup()
    const openSettings = vi.fn()
    window.addEventListener('og:open-model-settings-panel', openSettings, { once: true })
    render(<ModelsScreen />)
    await screen.findAllByRole('button', { name: 'Open model settings' })

    await user.click(
      within(cardFor('Active Model')).getByRole('button', { name: 'Open model settings' })
    )

    expect(openSettings).toHaveBeenCalledOnce()
    expect((openSettings.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ tab: 'model' })
    expect(activateModel).not.toHaveBeenCalled()
  })

  it.each([
    ['Image', 'Active Image Model', 'image'],
    ['Voice', 'Active Voice Model', 'voice']
  ] as const)('opens the %s tab for the active modality', async (kind, modelName, expectedTab) => {
    const user = userEvent.setup()
    const openSettings = vi.fn()
    window.addEventListener('og:open-model-settings-panel', openSettings, { once: true })
    render(<ModelsScreen />)

    await user.click(await screen.findByRole('button', { name: kind }))
    await user.click(
      within(cardFor(modelName)).getByRole('button', { name: 'Open model settings' })
    )

    expect((openSettings.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ tab: expectedTab })
  })

  it('does not offer model settings for transcription', async () => {
    const user = userEvent.setup()
    render(<ModelsScreen />)

    await user.click(await screen.findByRole('button', { name: 'Transcription' }))
    expect(
      within(cardFor('Active Transcription Model')).queryByRole('button', {
        name: 'Open model settings'
      })
    ).toBeNull()
  })
})
