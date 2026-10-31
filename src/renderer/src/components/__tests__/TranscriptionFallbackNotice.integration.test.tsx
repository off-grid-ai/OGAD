// @vitest-environment jsdom
// When Parakeet or Qwen3-ASR fails on a recording, main hands it to Whisper and says so over IPC
// (the boundary here); the person sees one line naming the engine that failed.
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ToastProvider } from '../../hooks/ToastProvider'
import { TranscriptionFallbackNotice } from '../TranscriptionFallbackNotice'

type Notice = { engine: 'parakeet' | 'qwen3-asr'; reason: string }

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('TranscriptionFallbackNotice', () => {
  it('says which engine failed and that Whisper transcribed instead', async () => {
    let send: ((notice: Notice) => void) | undefined
    ;(window as unknown as { api: unknown }).api = {
      onTranscriptionFallback: (callback: (notice: Notice) => void) => {
        send = callback
        return () => (send = undefined)
      }
    }
    render(
      <ToastProvider>
        <TranscriptionFallbackNotice />
      </ToastProvider>
    )

    act(() => send!({ engine: 'qwen3-asr', reason: 'HTTP 500' }))
    expect(
      await screen.findByText("Qwen3-ASR couldn't transcribe that, so Whisper did.")
    ).toBeTruthy()
    act(() => send!({ engine: 'parakeet', reason: 'exit 1' }))
    expect(
      await screen.findByText("Parakeet couldn't transcribe that, so Whisper did.")
    ).toBeTruthy()
  })
})
