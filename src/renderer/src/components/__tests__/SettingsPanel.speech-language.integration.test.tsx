// @vitest-environment jsdom

// Product integration: the real shared Settings panel gives people a direct language
// choice for both speech output and transcription. Only the Electron API boundary is fake.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SettingsPanel } from '../SettingsPanel'
import { normalizeBackendPreferences } from '../../../../shared/backend-preferences'
import type { BackendModality, BackendPreference } from '../../../../shared/backend-preferences'

const saveSetting = vi.fn(async () => undefined)
const setActiveModalModel = vi.fn<(kind: string, modelId: string | null) => Promise<void>>(
  async () => undefined
)
const getTranscriptionInfo = vi.fn()
let emitVoiceProgress:
  | ((data: {
      progress: number | null
      downloadedBytes?: number
      totalBytes?: number | null
      bytesPerSecond?: number
    }) => void)
  | undefined

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
    onTtsVoiceProgress: vi.fn((callback: typeof emitVoiceProgress) => {
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
  localStorage.clear()
})

/** A voice picker, once the voices have loaded and it can be opened. */
async function enabledPicker(name: string): Promise<HTMLElement> {
  const picker = await screen.findByRole('combobox', { name })
  await waitFor(() => expect((picker as HTMLButtonElement).disabled).toBe(false))
  return picker
}

describe('<SettingsPanel/> speech languages', () => {
  it('groups voice settings into sections, and a closed section says what is set inside', async () => {
    let preferences = normalizeBackendPreferences({}, 'linux')
    const savedBackends: Array<[BackendModality, BackendPreference]> = []
    Object.assign((window as unknown as { api: Record<string, unknown> }).api, {
      platform: 'linux',
      backendPreferencesGet: async () => preferences,
      backendPreferenceSet: async (modality: BackendModality, preference: BackendPreference) => {
        savedBackends.push([modality, preference])
        preferences = { ...preferences, [modality]: preference }
        return preferences
      },
      runtimeBackends: async () => []
    })
    render(<SettingsPanel onClose={() => {}} initialTab="voice" />)

    expect(await screen.findByRole('combobox', { name: 'Voice selection' })).toBeTruthy()
    const voiceSection = screen.getByRole('button', { name: /^Voice.*speaks at/ })
    expect(voiceSection).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Conversation/ })).toBeTruthy()
    expect(screen.getByText('Chat · playback on · Auto turns')).toBeTruthy()
    expect(await screen.findByText('Heart · English (US) · speaks at 1.0x')).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: 'Interface mode' })).toBeTruthy()

    // A single backend row has no section of its own: it sits in the open Voice section,
    // reachable without opening anything else.
    expect(screen.queryByRole('button', { name: /^Processing/ })).toBeNull()
    const speechBackend = within(voiceSection.parentElement as HTMLElement).getByRole('combobox', {
      name: 'Speech backend'
    })
    expect(speechBackend.textContent).toContain('Auto')

    const user = userEvent.setup()
    await user.click(speechBackend)
    expect(await screen.findByRole('option', { name: 'Auto' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'CUDA' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'WebGPU' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'CPU' })).toBeTruthy()
    await user.click(screen.getByRole('option', { name: 'WebGPU' }))
    await waitFor(() => expect(savedBackends).toEqual([['tts', 'webgpu']]))
    await waitFor(() => expect(speechBackend.textContent).toContain('WebGPU'))
  })

  it('saves playback speed after the slider loses focus', async () => {
    render(<SettingsPanel onClose={() => {}} initialTab="voice" />)

    const speed = await screen.findByRole('slider', { name: 'Playback speed' })
    const user = userEvent.setup()
    speed.focus()
    // 1.0x -> 1.5x is five 0.1x steps with the arrow key.
    await user.keyboard('{ArrowRight>5/}')
    expect(speed.getAttribute('aria-valuetext')).toBe('1.5x')
    expect((saveSetting.mock.calls as unknown[][]).some(([key]) => key === 'ttsSpeed')).toBe(false)

    await user.tab()
    await waitFor(() => expect(saveSetting).toHaveBeenCalledWith('ttsSpeed', 1.5))
  })

  it('shows the remote voice source without offering local speakers', async () => {
    const boundary = (window as unknown as { api: Record<string, unknown> }).api
    boundary.getActiveModalities = vi.fn().mockResolvedValue({
      speech: 'remote-vision:home:google%2Flyria-3-pro-preview'
    })
    boundary.ttsVoices = vi.fn().mockResolvedValue([])

    render(<SettingsPanel onClose={vi.fn()} initialTab="voice" />)

    expect(
      await screen.findByText('Speaker choices are not available for this remote model.')
    ).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Voice selection' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Language selection' })).toBeNull()
    expect(screen.queryByText('Sarah')).toBeNull()
  })

  it('names the selected remote transcription model in Settings', async () => {
    getTranscriptionInfo.mockResolvedValue({
      engine: 'remote',
      modelId: 'remote-vision:home:google%2Fgemini-3.7-flash',
      label: 'Remote · google/gemini-3.7-flash',
      language: 'auto',
      languages: [{ code: 'auto', label: 'Auto-detect' }],
      options: [
        {
          id: 'remote-vision:home:google%2Fgemini-3.7-flash',
          name: 'Google: Gemini 3.7 Flash',
          active: true
        }
      ]
    })

    render(<SettingsPanel onClose={vi.fn()} initialTab="transcription" />)

    expect(await screen.findByText('Remote · google/gemini-3.7-flash')).toBeTruthy()
    expect(screen.queryByText(/Whisper · Whisper Base/)).toBeNull()
  })

  it('ignores a malformed saved voice instead of showing an object as a voice name', async () => {
    const boundary = (window as unknown as { api: Record<string, unknown> }).api
    boundary.getSettings = vi.fn().mockResolvedValue({ ttsVoice: { id: 'af_heart' } })

    render(<SettingsPanel onClose={vi.fn()} initialTab="voice" />)

    const voice = await screen.findByRole('combobox', { name: 'Voice selection' })
    expect(voice.textContent).toContain('Heart')
    expect(screen.queryByText('[object Object]')).toBeNull()
  })

  it('lets the user choose a TTS language and selects a live voice for it', async () => {
    const view = render(<SettingsPanel onClose={vi.fn()} initialTab="voice" />)
    expect(view.container.querySelector('select')).toBeNull()

    const user = userEvent.setup()
    await user.click(await enabledPicker('Language selection'))
    await user.click(await screen.findByRole('option', { name: 'French' }))

    await waitFor(() => expect(saveSetting).toHaveBeenCalledWith('ttsVoice', 'ff_siwis'))
    await user.click(screen.getByRole('combobox', { name: 'Voice selection' }))
    expect(await screen.findByRole('option', { name: 'Siwis' })).toBeTruthy()
  })

  it('supports keyboard selection in the custom language menu', async () => {
    render(<SettingsPanel onClose={vi.fn()} initialTab="voice" />)

    const user = userEvent.setup()
    const language = await screen.findByRole('combobox', { name: 'Language selection' })
    await waitFor(() => expect((language as HTMLButtonElement).disabled).toBe(false))
    language.focus()
    await user.keyboard('{Enter}')
    // The list opens before the arrows move through it, as a person sees it open.
    await screen.findByRole('option', { name: 'French' })
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')

    await waitFor(() => expect(saveSetting).toHaveBeenCalledWith('ttsVoice', 'ff_siwis'))
    expect(language.textContent).toContain('French')
  })

  it('closes only the custom language menu on Escape and restores trigger focus', async () => {
    const onClose = vi.fn()
    render(<SettingsPanel onClose={onClose} initialTab="voice" />)

    const user = userEvent.setup()
    const language = await enabledPicker('Language selection')
    await user.click(language)
    await waitFor(() => expect(language.getAttribute('aria-expanded')).toBe('true'))

    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('option')).toBeNull())
    expect(onClose).not.toHaveBeenCalled()
    // Focus goes back to the trigger once the list has finished closing.
    await waitFor(() => expect(document.activeElement).toBe(language))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes the custom menu when the user clicks another setting', async () => {
    const onClose = vi.fn()
    render(<SettingsPanel onClose={onClose} initialTab="voice" />)

    const user = userEvent.setup()
    await user.click(await enabledPicker('Language selection'))
    expect(await screen.findByRole('option', { name: 'French' })).toBeTruthy()

    fireEvent.pointerDown(document.body)

    await waitFor(() => expect(screen.queryByRole('option')).toBeNull())
    expect(onClose).not.toHaveBeenCalled()
  })

  it('exposes the selected value and menu state to assistive technology', async () => {
    render(<SettingsPanel onClose={vi.fn()} initialTab="voice" />)

    const user = userEvent.setup()
    const voice = await enabledPicker('Voice selection')
    expect(voice.getAttribute('aria-haspopup')).toBe('listbox')
    expect(voice.getAttribute('aria-expanded')).toBe('false')

    await user.click(voice)

    await waitFor(() => expect(voice.getAttribute('aria-expanded')).toBe('true'))
    expect(
      (await screen.findByRole('option', { name: 'Heart' })).getAttribute('aria-selected')
    ).toBe('true')
  })

  it('shows every voice and language exposed by the active runtime', async () => {
    render(<SettingsPanel onClose={vi.fn()} initialTab="voice" />)

    const user = userEvent.setup()
    await user.click(await enabledPicker('Voice selection'))
    expect(await screen.findByRole('option', { name: 'Heart' })).toBeTruthy()
    expect(await screen.findByRole('option', { name: 'Bella' })).toBeTruthy()
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('combobox', { name: 'Language selection' }))
    await user.click(await screen.findByRole('option', { name: 'Irish' }))
    await waitFor(() => expect(saveSetting).toHaveBeenCalledWith('ttsVoice', 'future_voice'))
    expect(screen.getByRole('combobox', { name: 'Language selection' }).textContent).toContain(
      'Irish'
    )
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
      (screen.getByRole('combobox', { name: 'Language selection' }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect(
      (screen.getByRole('combobox', { name: 'Voice selection' }) as HTMLButtonElement).disabled
    ).toBe(true)
    finishLoading([
      { id: 'af_heart', label: 'Heart', language: 'en-US' },
      { id: 'af_bella', label: 'Bella', language: 'en-US' }
    ])
    expect(await screen.findByText('Checking voice files...')).toBeTruthy()
    emitVoiceProgress?.({
      progress: 43,
      downloadedBytes: 43 * 1024 * 1024,
      totalBytes: 100 * 1024 * 1024,
      bytesPerSecond: 2 * 1024 * 1024
    })
    // The percentage rolls in its own number span, so read the status line as a whole.
    expect(
      await screen.findByText(
        (_content, element) =>
          element?.getAttribute('role') === 'status' &&
          /Downloading English \(US\) audio - 43%/.test(element.textContent ?? '')
      )
    ).toBeTruthy()
    expect(screen.getByText(/45 MB \/ 105 MB/)).toBeTruthy()
    expect(screen.getByText(/2\.0 MB\/s/)).toBeTruthy()
    finishPreparing()
    expect(await screen.findByText('English (US) voice ready.')).toBeTruthy()
    expect(
      (screen.getByRole('combobox', { name: 'Language selection' }) as HTMLButtonElement).disabled
    ).toBe(false)
    expect(
      (screen.getByRole('combobox', { name: 'Voice selection' }) as HTMLButtonElement).disabled
    ).toBe(false)
  })

  it('keeps an unknown voice download finite and never renders NaN', async () => {
    let finishPreparing!: () => void
    const boundary = (window as unknown as { api: Record<string, unknown> }).api
    boundary.prepareTtsVoice = vi.fn(
      () =>
        new Promise((resolve) => {
          finishPreparing = () => resolve({ ready: true })
        })
    )

    render(<SettingsPanel onClose={vi.fn()} initialTab="voice" />)
    expect(await screen.findByText('Checking voice files...')).toBeTruthy()
    emitVoiceProgress?.({ progress: null, downloadedBytes: Number.NaN, totalBytes: null })

    expect(await screen.findByText(/Downloading English \(US\) audio\.\.\./)).toBeTruthy()
    expect(document.body.textContent).not.toContain('NaN')
    finishPreparing()
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
    await user.click(screen.getByRole('combobox', { name: 'Spoken language' }))
    await user.click(await screen.findByRole('option', { name: 'Korean' }))

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
    const model = await screen.findByRole('combobox', { name: 'Current transcription model' })
    expect(model.textContent).toContain('Whisper Large v3')
    await user.click(model)
    expect(screen.queryByRole('option', { name: 'Uninstalled model' })).toBeNull()
    await user.click(await screen.findByRole('option', { name: 'Parakeet v2' }))

    await waitFor(() =>
      expect(setActiveModalModel).toHaveBeenCalledWith('transcription', 'parakeet-v2', 'settings')
    )
    expect(model.textContent).toContain('Parakeet v2')
    expect(screen.getByRole('combobox', { name: 'Spoken language' }).textContent).toContain(
      'English'
    )

    first.unmount()
    render(<SettingsPanel onClose={vi.fn()} initialTab="transcription" />)
    expect(
      (await screen.findByRole('combobox', { name: 'Current transcription model' })).textContent
    ).toContain('Parakeet v2')
    expect(setActiveModalModel).toHaveBeenCalledTimes(1)
  })

  it('restores the persisted STT language when saving fails', async () => {
    saveSetting.mockRejectedValueOnce(new Error('disk full'))
    render(<SettingsPanel onClose={vi.fn()} initialTab="transcription" />)

    const user = userEvent.setup()
    const language = await screen.findByRole('combobox', { name: 'Spoken language' })
    await user.click(language)
    await user.click(await screen.findByRole('option', { name: 'Korean' }))

    await waitFor(() => expect(getTranscriptionInfo).toHaveBeenCalledTimes(2))
    expect(language.textContent).toContain('Auto-detect')
  })
})
