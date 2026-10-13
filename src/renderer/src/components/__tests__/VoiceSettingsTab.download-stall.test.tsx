// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VoiceSettingsTab } from '../VoiceSettingsTab'

type ProgressListener = (progress: {
  voiceId?: string
  progress: number
  downloadedBytes?: number
  totalBytes?: number
}) => void

/** The preload boundary as the renderer sees it: a voice download that reports 100% of 0 bytes
 *  once and then never finishes. */
function installHungVoiceDownload(): { emit: ProgressListener } {
  let listener: ProgressListener = () => {}
  ;(window as unknown as { api: unknown }).api = {
    getActiveModalities: async () => ({}),
    ttsVoices: async () => [{ id: 'af_heart', label: 'Heart', language: 'en-US' }],
    getSettings: async () => ({ ttsVoice: 'af_heart' }),
    saveSetting: async () => undefined,
    prepareTtsVoice: () => new Promise(() => {}),
    onTtsVoiceProgress: (next: ProgressListener) => {
      listener = next
      return () => {}
    }
  }
  return { emit: (progress) => listener(progress) }
}

describe('<VoiceSettingsTab/> voice download', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('offers Retry when a download stops at 100% of 0 MB', async () => {
    const boundary = installHungVoiceDownload()
    render(<VoiceSettingsTab />)
    await screen.findByText('Checking voice files...')

    act(() =>
      boundary.emit({ voiceId: 'af_heart', progress: 100, downloadedBytes: 0, totalBytes: 0 })
    )
    const status = await screen.findByText(/Downloading .* audio/)
    expect(status.textContent).not.toContain('0 MB / 0 MB')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(screen.getByRole('alert').textContent).toContain('The voice download stopped')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })
})
