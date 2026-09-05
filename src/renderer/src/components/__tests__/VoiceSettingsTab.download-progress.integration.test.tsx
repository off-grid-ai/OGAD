// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { VoiceSettingsTab } from '../VoiceSettingsTab'

afterEach(cleanup)

it('shows byte totals and measured rate while native voice preparation is pending', async () => {
  let progress!: (value: {
    voiceId: string
    progress: number | null
    downloadedBytes: number
    totalBytes?: number
    sampledAtMs: number
  }) => void
  let finish!: () => void
  let preparing = false
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ttsVoices: async () => [{ id: 'af_heart', name: 'Heart' }],
      getSettings: async () => ({ ttsVoice: 'af_heart' }),
      onTtsVoiceProgress: (listener: typeof progress) => {
        progress = listener
        return () => undefined
      },
      prepareTtsVoice: () => {
        preparing = true
        return new Promise<void>((resolve) => {
          finish = resolve
        })
      },
      speechCommands: { onEvent: () => () => undefined },
      saveSetting: async () => undefined
    }
  })
  render(<VoiceSettingsTab />)
  try {
    await waitFor(() => expect(preparing).toBe(true))
    act(() =>
      progress({
        voiceId: 'af_heart',
        progress: null,
        downloadedBytes: 1_000_000,
        sampledAtMs: 1000
      })
    )
    expect(screen.getByRole('status').textContent).toContain(
      '1 MB downloaded - Total size unavailable'
    )
    expect(screen.getByRole('status').textContent).toContain('Rate unavailable')
    act(() =>
      progress({
        voiceId: 'af_heart',
        progress: 50,
        downloadedBytes: 2_048_576,
        totalBytes: 4_097_152,
        sampledAtMs: 2000
      })
    )
    expect(screen.getByRole('status').textContent).toContain('50%')
    expect(screen.getByRole('status').textContent).toContain('2 MB of 4 MB')
    expect(screen.getByRole('status').textContent).toContain('1.0 MB/s')
    await act(async () => {
      finish()
    })
    expect(screen.getByRole('status').textContent).toContain('voice ready')
  } finally {
    await act(async () => {
      finish?.()
    })
  }
})
