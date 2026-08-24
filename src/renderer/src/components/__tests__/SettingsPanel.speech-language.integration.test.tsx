// @vitest-environment jsdom

// Product integration: the real shared Settings panel gives people a direct language
// choice for both speech output and transcription. Only the Electron API boundary is fake.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SettingsPanel } from '../SettingsPanel'

const saveSetting = vi.fn(async () => undefined)
const getTranscriptionInfo = vi.fn()
let emitVoiceProgress: ((data: { progress: number }) => void) | undefined

beforeEach(() => {
  emitVoiceProgress = undefined
  saveSetting.mockClear()
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
    options: []
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
    ]),
    onTtsVoiceProgress: vi.fn((callback: (data: { progress: number }) => void) => {
      emitVoiceProgress = callback
      return vi.fn()
    }),
    getTranscriptionInfo,
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

    const voice = (await screen.findByRole('combobox', { name: 'Voice' })) as HTMLSelectElement
    expect(voice.value).toBe('af_heart')
    expect(screen.queryByRole('option', { name: '[object Object]' })).toBeNull()
  })

  it('lets the user choose a TTS language and selects a live voice for it', async () => {
    render(<SettingsPanel onClose={vi.fn()} initialTab="voice" />)

    const language = await screen.findByRole('combobox', { name: /language/i })
    fireEvent.change(language, { target: { value: 'fr' } })

    await waitFor(() => expect(saveSetting).toHaveBeenCalledWith('ttsVoice', 'ff_siwis'))
    expect(screen.getByRole('option', { name: 'Siwis' })).toBeTruthy()
  })

  it('shows every voice returned by the active runtime', async () => {
    render(<SettingsPanel onClose={vi.fn()} initialTab="voice" />)

    expect(await screen.findByRole('option', { name: 'Bella' })).toBeTruthy()
  })

  it('shows voice loading progress and changes to ready only after loading completes', async () => {
    let finishLoading!: (voices: { id: string; label: string; language: string }[]) => void
    const boundary = (window as unknown as { api: Record<string, unknown> }).api
    boundary.ttsVoices = vi.fn(() => new Promise((resolve) => { finishLoading = resolve }))

    render(<SettingsPanel onClose={vi.fn()} initialTab="voice" />)

    expect(await screen.findByText('Loading voices - 0%')).toBeTruthy()
    emitVoiceProgress?.({ progress: 43 })
    expect(await screen.findByText('Loading voices - 43%')).toBeTruthy()

    finishLoading([
      { id: 'af_heart', label: 'Heart', language: 'en-US' },
      { id: 'af_bella', label: 'Bella', language: 'en-US' },
    ])
    expect(await screen.findByText('English (US) voice ready.')).toBeTruthy()
  })

  it('shows a clear failure and retries voice loading', async () => {
    const boundary = (window as unknown as { api: Record<string, unknown> }).api
    const ttsVoices = vi.fn()
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
    render(<SettingsPanel onClose={vi.fn()} initialTab="transcription" />)

    expect(await screen.findByText('Whisper · Whisper Large v3')).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: /spoken language/i }), {
      target: { value: 'ko' }
    })

    await waitFor(() => expect(saveSetting).toHaveBeenCalledWith('sttLanguage', 'ko'))
  })

  it('restores the persisted STT language when saving fails', async () => {
    saveSetting.mockRejectedValueOnce(new Error('disk full'))
    render(<SettingsPanel onClose={vi.fn()} initialTab="transcription" />)

    const language = await screen.findByRole('combobox', { name: /spoken language/i })
    fireEvent.change(language, { target: { value: 'ko' } })

    await waitFor(() => expect(getTranscriptionInfo).toHaveBeenCalledTimes(2))
    expect((language as HTMLSelectElement).value).toBe('auto')
  })
})
