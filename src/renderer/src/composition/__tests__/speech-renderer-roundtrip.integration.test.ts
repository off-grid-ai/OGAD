// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  SpeechMicrophoneLevel,
  SpeechMicrophoneRequest,
  SpeechMicrophoneResult
} from '../../../../shared/speech-microphone-contract'
import type {
  SpeechPlaybackRequest,
  SpeechPlaybackResult
} from '../../../../shared/speech-playback-contract'
import type {
  SpeechTextCleanRequest,
  SpeechTextCleanResult
} from '../../../../shared/speech-text-cleaning-contract'
import { attachSpeechMicrophoneAdapter } from '../speech-microphone-adapter'
import { attachSpeechPlaybackAdapter } from '../speech-playback-adapter'
import { attachSpeechTextCleaningAdapter } from '../speech-text-cleaning-adapter'

class RequestBoundary<Request, Result> {
  listener: ((request: Request) => void) | null = null
  readonly results: Result[] = []

  onRequest(listener: (request: Request) => void): () => void {
    this.listener = listener
    return () => {
      if (this.listener === listener) this.listener = null
    }
  }

  request(value: Request): void {
    this.listener?.(value)
  }

  sendResult(value: Result): void {
    this.results.push(value)
  }
}

class RecorderBoundary {
  static isTypeSupported(): boolean {
    return true
  }

  state: RecordingState = 'inactive'
  readonly mimeType = 'audio/webm'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null

  start(): void {
    this.state = 'recording'
    this.ondataavailable?.({ data: new Blob(['voice-bytes'], { type: this.mimeType }) })
  }

  stop(): void {
    this.state = 'inactive'
    this.onstop?.()
  }
}

class AudioContextBoundary {
  state: AudioContextState = 'running'

  createMediaStreamSource(): { connect(): void } {
    return { connect: () => undefined }
  }

  createAnalyser(): AnalyserNode {
    return {
      fftSize: 32,
      getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.1)
    } as unknown as AnalyserNode
  }

  close(): Promise<void> {
    this.state = 'closed'
    return Promise.resolve()
  }
}

class AudioBoundary {
  static instances: AudioBoundary[] = []
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  readonly pause = vi.fn()
  readonly load = vi.fn()
  readonly removeAttribute = vi.fn()
  readonly play = vi.fn(async () => undefined)

  constructor(readonly source: string) {
    AudioBoundary.instances.push(this)
  }
}

const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('renderer speech round trip', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    AudioBoundary.instances = []
  })

  it('captures speech, cleans the answer, and plays it to completion', async () => {
    const stopTrack = vi.fn()
    const track = {
      stop: stopTrack,
      getSettings: () => ({ echoCancellation: true })
    }
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track]
    } as unknown as MediaStream
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => stream) }
    })
    vi.stubGlobal('MediaRecorder', RecorderBoundary)
    vi.stubGlobal('AudioContext', AudioContextBoundary)

    const microphone = new RequestBoundary<SpeechMicrophoneRequest, SpeechMicrophoneResult>()
    const levels: SpeechMicrophoneLevel[] = []
    const stopMicrophone = attachSpeechMicrophoneAdapter({
      ...microphone,
      onRequest: microphone.onRequest.bind(microphone),
      sendResult: microphone.sendResult.bind(microphone),
      sendLevel: (level) => levels.push(level)
    })
    microphone.request({ type: 'start', requestId: 'capture-1' })
    await vi.waitFor(() =>
      expect(microphone.results[0]).toEqual({
        type: 'start',
        requestId: 'capture-1',
        status: 'completed',
        echoCancelled: true
      })
    )
    microphone.request({ type: 'stop', requestId: 'stop-1', captureId: 'capture-1' })
    await vi.waitFor(() =>
      expect(microphone.results[1]).toMatchObject({
        type: 'stop',
        requestId: 'stop-1',
        status: 'completed',
        audio: { mime: 'audio/webm' }
      })
    )
    expect(stopTrack).toHaveBeenCalledOnce()

    const cleaning = new RequestBoundary<SpeechTextCleanRequest, SpeechTextCleanResult>()
    const stopCleaning = attachSpeechTextCleaningAdapter(cleaning)
    cleaning.request({
      type: 'clean',
      requestId: 'clean-1',
      text: '**Answer:** open the [private note](https://example.test).'
    })
    await settle()
    expect(cleaning.results).toEqual([
      {
        requestId: 'clean-1',
        status: 'completed',
        text: 'Answer: open the private note.'
      }
    ])

    const playback = new RequestBoundary<SpeechPlaybackRequest, SpeechPlaybackResult>()
    const stopPlayback = attachSpeechPlaybackAdapter(playback, (source) => {
      return new AudioBoundary(source) as unknown as HTMLAudioElement
    })
    playback.request({
      type: 'play',
      requestId: 'play-1',
      audio: { kind: 'inline', dataUri: 'data:audio/wav;base64,UklGRg==' }
    })
    expect(AudioBoundary.instances[0]?.source).toBe('data:audio/wav;base64,UklGRg==')
    AudioBoundary.instances[0]?.onended?.()
    expect(playback.results).toEqual([{ requestId: 'play-1', status: 'completed' }])

    stopPlayback()
    stopCleaning()
    stopMicrophone()
    expect(microphone.listener).toBeNull()
    expect(cleaning.listener).toBeNull()
    expect(playback.listener).toBeNull()
  })
})
