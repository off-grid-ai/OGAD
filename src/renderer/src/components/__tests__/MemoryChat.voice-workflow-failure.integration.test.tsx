// @vitest-environment jsdom

/**
 * A rendered voice question through MemoryChat and the Shared workflow projection.
 * Browser microphone primitives and Electron IPC are the only controlled boundaries.
 */
import { act, cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatBoundary, installBoundary, renderChat } from './harness/chat-boundary'

class RecorderBoundary {
  static isTypeSupported = (): boolean => true
  state: RecordingState = 'inactive'
  mimeType: string
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType ?? 'audio/webm'
  }

  start(): void {
    this.state = 'recording'
    this.ondataavailable?.({ data: new Blob(['voice'], { type: this.mimeType }) })
  }

  stop(): void {
    this.state = 'inactive'
    this.onstop?.()
  }
}

class AudioContextBoundary {
  createMediaStreamSource(): { connect(): void } {
    return { connect: () => undefined }
  }

  createAnalyser(): AnalyserNode {
    return {
      fftSize: 2048,
      getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.01)
    } as unknown as AnalyserNode
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

describe('<MemoryChat/> Shared voice-workflow failure', () => {
  beforeEach(() => {
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => stream) }
    })
    vi.stubGlobal('MediaRecorder', RecorderBoundary)
    vi.stubGlobal('AudioContext', AudioContextBoundary)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Blob decoding is outside jsdom')))
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:voice-question')
    })
    ;(Element.prototype as unknown as { scrollIntoView(): void }).scrollIntoView = () => undefined
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      callback(0)
      return 1
    }
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('shows the Shared speech failure and returns the microphone to a retryable state', async () => {
    const boundary = new ChatBoundary()
    installBoundary(boundary)
    renderChat({ conversationId: 'conversation-a' })
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: 'Record voice' }))
    await user.click(await screen.findByRole('button', { name: 'Stop recording' }))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(boundary.voiceQuestionOperations).toHaveLength(1)

    act(() => {
      boundary.failVoiceQuestion({
        kind: 'speech',
        failure: { kind: 'not_configured', modality: 'stt' }
      })
    })

    expect(await screen.findByText('No STT model is configured.')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Record voice' }))
    await user.click(screen.getByRole('button', { name: 'Stop recording' }))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.queryByText('No STT model is configured.')).toBeNull()
    expect(boundary.voiceQuestionOperations).toHaveLength(2)
  })
})
