// @vitest-environment jsdom

// Product integration: the real shared Settings panel gives people a direct language
// choice for both speech output and transcription. Only the Electron API boundary is fake.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SettingsPanel } from '../SettingsPanel'

const saveSetting = vi.fn(async () => undefined)
const getTranscriptionInfo = vi.fn()

beforeEach(() => {
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
    ttsVoices: vi.fn().mockResolvedValue(['af_heart', 'bf_emma', 'ff_siwis']),
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
  it('lets the user choose a TTS language and selects a live voice for it', async () => {
    render(<SettingsPanel onClose={vi.fn()} initialTab="voice" />)

    const language = await screen.findByRole('combobox', { name: /language/i })
    fireEvent.change(language, { target: { value: 'fr' } })

    await waitFor(() => expect(saveSetting).toHaveBeenCalledWith('ttsVoice', 'ff_siwis'))
    expect(screen.getByRole('option', { name: 'Siwis' })).toBeTruthy()
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
