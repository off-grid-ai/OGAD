// @vitest-environment jsdom

// Product integration: the real shared Settings panel gives people a direct language
// choice for both speech output and transcription. Only the Electron API boundary is fake.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SettingsPanel } from '../SettingsPanel'

const saveSetting = vi.fn(async () => undefined)
const setActiveModalModel = vi.fn<(kind: string, modelId: string | null) => Promise<void>>(
  async () => undefined
)
const getTranscriptionInfo = vi.fn()
let emitVoiceProgress: ((data: { progress: number }) => void) | undefined

beforeEach(() => {
  emitVoiceProgress = undefined
  saveSetting.mockClear()
  setActiveModalModel.mockClear()
  getTranscriptionInfo.mockReset()
  getTranscriptionInfo.mockResolvedValue({
    engine: 'whisper',
    modelId: 'whisper-large-v3',
    label: 'Whisper · Whisper Large v3',
    language: 'auto',
    languages: [
      { code: 'auto', label: 'Auto-detect' },
      { code: 'en', label: 'English' },
      { code: 'fr', label: 'French' },
      { code: 'de', label: 'German' },
      { code: 'ko', label: 'Korean' }
    ],
    options: [
      { id: null, name: 'Whisper (built-in)', active: false },
      { id: 'whisper-large-v3', name: 'Whisper Large v3', active: true }
    ]
  })
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    getLlmSettings: vi.fn().mockResolvedValue({}),
    getModelCatalog: vi.fn().mockResolvedValue({ models: [] }),
    getActiveModel: vi.fn().mockResolvedValue(null),
    ttsVoices: vi.fn().mockResolvedValue([
      { id: 'af_heart', label: 'Heart', language: 'en-US' },
      { id: 'af_bella', label: 'Bella', language: 'en-US' },
      { id: 'bf_emma', label: 'Emma', language: 'en-GB' },
      { id: 'ff_siwis', label: 'Siwis', language: 'fr' },
      { id: 'future_voice', label: 'Nora', language: 'ga', languageLabel: 'Irish' }
    ]),
    prepareTtsVoice: vi.fn().mockResolvedValue({ ready: true }),
    onTtsVoiceProgress: vi.fn((callback: (data: { progress: number }) => void) => {
      emitVoiceProgress = callback
      return vi.fn()
    }),
    getTranscriptionInfo,
    setActiveModalModel,
    listTools: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue({ ttsVoice: 'af_heart' }),
    mcpList: vi.fn().mockResolvedValue([]),
    saveSetting
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('<SettingsPanel/> speech languages', () => {
  it('ignores a malformed saved voice instead of showing an object as a voice name', async () => {
    const boundary = (window as unknown as { api: Record<string, unknown> }).api
    boundary.getSettings = vi.fn().mockResolvedValue({ ttsVoice: { id: 'af_heart' } })

    render(<SettingsPanel onClose={vi.fn()} initialTab="voice" />)

    const voice = await screen.findByRole('button', { name: 'Voice selection' })
    expect(voice.textContent).toContain('Heart')
    expect(screen.queryByText('[object Object]')).toBeNull()
  })

  it('lets the user choose a TTS language and selects a live voice for it', async () => {
    const view = render(<SettingsPanel onClose={vi.fn()} initialTab="voice" />)
    expect(view.container.querySelector('select')).toBeNull()

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Language selection' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'French' }))

    await waitFor(() => expect(saveSetting).toHaveBeenCalledWith('ttsVoice', 'ff_siwis'))
    await user.click(screen.getByRole('button', { name: 'Voice selection' }))
    expect(screen.getByRole('menuitemradio', { name: 'Siwis' })).toBeTruthy()
  })

  it('supports keyboard selection in the custom language menu', async () => {
    render(<SettingsPanel onClose={vi.fn()} initialTab="voice" />)

    const user = userEvent.setup()
    const language = await screen.findByRole('button', { name: 'Language selection' })
    language.focus()
    await user.keyboard('{Enter}{ArrowDown}{ArrowDown}{Enter}')

    await waitFor(() => expect(saveSetting).toHaveBeenCalledWith('ttsVoice', 'ff_siwis'))
    expect(language.textContent).toContain('French')
  })

  it('closes only the custom language menu on Escape and restores trigger focus', async () => {
    const onClose = vi.fn()
    render(<SettingsPanel onClose={onClose} initialTab="voice" />)

    const user = userEvent.setup()
    const language = await screen.findByRole('button', { name: 'Language selection' })
    await user.click(language)
    expect(language.getAttribute('aria-expanded')).toBe('true')

    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('menuitemradio')).toBeNull())
    expect(onClose).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(language)
  })

  it('closes the custom menu when the user clicks another setting', async () => {
    const onClose = vi.fn()
    render(<SettingsPanel onClose={onClose} initialTab="voice" />)

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Language selection' }))
    expect(screen.getByRole('menuitemradio', { name: 'French' })).toBeTruthy()

    fireEvent.pointerDown(document.body)

    await waitFor(() => expect(screen.queryByRole('menuitemradio')).toBeNull())
    expect(onClose).not.toHaveBeenCalled()
  })

  it('exposes the selected value and menu state to assistive technology', async () => {
    render(<SettingsPanel onClose={vi.fn()} initialTab="voice" />)

    const user = userEvent.setup()
    const voice = await screen.findByRole('button', { name: 'Voice selection' })
    expect(voice.getAttribute('aria-haspopup')).toBe('menu')
    expect(voice.getAttribute('aria-expanded')).toBe('false')

    await user.click(voice)

    expect(voice.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('menuitemradio', { name: 'Heart' }).getAttribute('aria-checked')).toBe(
      'true'
    )
  })

  it('shows every voice and language exposed by the active runtime', async () => {
    render(<SettingsPanel onClose={vi.fn()} initialTab="voice" />)

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Voice selection' }))
    expect(screen.getByRole('menuitemradio', { name: 'Heart' })).toBeTruthy()
    expect(screen.getByRole('menuitemradio', { name: 'Bella' })).toBeTruthy()
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Language selection' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'Irish' }))
    await waitFor(() => expect(saveSetting).toHaveBeenCalledWith('ttsVoice', 'future_voice'))
    expect(screen.getByRole('button', { name: 'Language selection' }).textContent).toContain('Irish')
  })

  it('shows voice loading progress and changes to ready only after loading completes', async () => {
    let finishLoading!: (voices: { id: string; label: string; language: string }[]) => void
    let finishPreparing!: () => void
    const boundary = (window as unknown as { api: Record<string, unknown> }).api
    boundary.ttsVoices = vi.fn(
      () =>
        new Promise((resolve) => {
          finishLoading = resolve
        })
    )
    boundary.prepareTtsVoice = vi.fn(
      () =>
        new Promise((resolve) => {
          finishPreparing = () => resolve({ ready: true })
        })
    )

    render(<SettingsPanel onClose={vi.fn()} initialTab="voice" />)

    expect(await screen.findByText('Loading voices...')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Language selection' }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Voice selection' }) as HTMLButtonElement).disabled
    ).toBe(true)
    finishLoading([
      { id: 'af_heart', label: 'Heart', language: 'en-US' },
      { id: 'af_bella', label: 'Bella', language: 'en-US' }
    ])
    expect(await screen.findByText('Checking voice files...')).toBeTruthy()
    emitVoiceProgress?.({ progress: 43 })
    expect(await screen.findByText('Downloading English (US) audio - 43%')).toBeTruthy()
    finishPreparing()
    expect(await screen.findByText('English (US) voice ready.')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Language selection' }) as HTMLButtonElement).disabled
    ).toBe(false)
    expect(
      (screen.getByRole('button', { name: 'Voice selection' }) as HTMLButtonElement).disabled
    ).toBe(false)
  })

  it('shows a clear failure and retries voice loading', async () => {
    const boundary = (window as unknown as { api: Record<string, unknown> }).api
    const ttsVoices = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce([{ id: 'af_heart', label: 'Heart', language: 'en-US' }])
    boundary.ttsVoices = ttsVoices

    render(<SettingsPanel onClose={vi.fn()} initialTab="voice" />)

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not load voices. Check your connection and retry.'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('English (US) voice ready.')).toBeTruthy()
    expect(ttsVoices).toHaveBeenCalledTimes(2)
  })

  it('uses the selected STT language for the next transcription', async () => {
    const view = render(<SettingsPanel onClose={vi.fn()} initialTab="transcription" />)
    expect(view.container.querySelector('select')).toBeNull()

    const user = userEvent.setup()
    expect(await screen.findByText('Whisper · Whisper Large v3')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Spoken language' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'Korean' }))

    await waitFor(() => expect(saveSetting).toHaveBeenCalledWith('sttLanguage', 'ko'))
  })

  it('switches only the transcription model and restores it when Settings reopens', async () => {
    let activeModel = 'whisper-large-v3'
    const info = (): {
      engine: 'parakeet' | 'whisper'
      modelId: string
      label: string
      language: string
      languages: { code: string; label: string }[]
      options: { id: string; name: string; active: boolean }[]
    } => ({
      engine: activeModel === 'parakeet-v2' ? ('parakeet' as const) : ('whisper' as const),
      modelId: activeModel,
      label:
        activeModel === 'parakeet-v2' ? 'Parakeet · Parakeet v2' : 'Whisper · Whisper Large v3',
      language: activeModel === 'parakeet-v2' ? 'en' : 'auto',
      languages:
        activeModel === 'parakeet-v2'
          ? [{ code: 'en', label: 'English' }]
          : [
              { code: 'auto', label: 'Auto-detect' },
              { code: 'hi', label: 'Hindi' }
            ],
      options: [
        {
          id: 'whisper-large-v3',
          name: 'Whisper Large v3',
          active: activeModel === 'whisper-large-v3'
        },
        { id: 'parakeet-v2', name: 'Parakeet v2', active: activeModel === 'parakeet-v2' }
      ]
    })
    getTranscriptionInfo.mockImplementation(async () => info())
    setActiveModalModel.mockImplementation(async (kind: string, modelId: string | null) => {
      expect(kind).toBe('transcription')
      activeModel = modelId ?? 'whisper-large-v3'
    })

    const first = render(<SettingsPanel onClose={vi.fn()} initialTab="transcription" />)
    const user = userEvent.setup()
    const model = await screen.findByRole('button', { name: 'Current transcription model' })
    expect(model.textContent).toContain('Whisper Large v3')
    await user.click(model)
    expect(screen.queryByRole('menuitemradio', { name: 'Uninstalled model' })).toBeNull()
    await user.click(screen.getByRole('menuitemradio', { name: 'Parakeet v2' }))

    await waitFor(() =>
      expect(setActiveModalModel).toHaveBeenCalledWith('transcription', 'parakeet-v2')
    )
    expect(model.textContent).toContain('Parakeet v2')
    expect(screen.getByRole('button', { name: 'Spoken language' }).textContent).toContain('English')

    first.unmount()
    render(<SettingsPanel onClose={vi.fn()} initialTab="transcription" />)
    expect(
      (await screen.findByRole('button', { name: 'Current transcription model' })).textContent
    ).toContain('Parakeet v2')
    expect(setActiveModalModel).toHaveBeenCalledTimes(1)
  })

  it('restores the persisted STT language when saving fails', async () => {
    saveSetting.mockRejectedValueOnce(new Error('disk full'))
    render(<SettingsPanel onClose={vi.fn()} initialTab="transcription" />)

    const user = userEvent.setup()
    const language = await screen.findByRole('button', { name: 'Spoken language' })
    await user.click(language)
    await user.click(screen.getByRole('menuitemradio', { name: 'Korean' }))

    await waitFor(() => expect(getTranscriptionInfo).toHaveBeenCalledTimes(2))
    expect(language.textContent).toContain('Auto-detect')
  })
})
