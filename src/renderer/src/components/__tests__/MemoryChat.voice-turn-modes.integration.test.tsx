// @vitest-environment jsdom

/**
 * Desktop chat voice turns through the production MemoryChat and shared speech endpoint.
 * Only the browser microphone/audio devices and Electron IPC are controlled boundaries.
 */
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatBoundary, installBoundary, renderChat } from './harness/chat-boundary'

class RecorderBoundary {
  static instances: RecorderBoundary[] = []
  static isTypeSupported = (): boolean => true

  state: RecordingState = 'inactive'
  mimeType: string
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType ?? 'audio/webm'
    RecorderBoundary.instances.push(this)
  }

  start(): void {
    this.state = 'recording'
    this.ondataavailable?.({
      data: new Blob(['recorded-audio'], { type: this.mimeType })
    })
  }

  stop(): void {
    if (this.state === 'inactive') return
    this.state = 'inactive'
    this.onstop?.()
  }
}

let microphoneLevel = 0.01

class AudioContextBoundary {
  createMediaStreamSource(): { connect: () => void } {
    return { connect: () => {} }
  }

  createAnalyser(): AnalyserNode {
    return {
      fftSize: 2048,
      getFloatTimeDomainData: (samples: Float32Array) => samples.fill(microphoneLevel)
    } as unknown as AnalyserNode
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

class AudioBoundary {
  static instances: AudioBoundary[] = []

  paused = true
  currentTime = 0
  duration = 1
  playbackRate = 1
  error: MediaError | null = null
  ontimeupdate: (() => void) | null = null
  onloadedmetadata: (() => void) | null = null
  onended: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(public readonly src: string) {
    AudioBoundary.instances.push(this)
  }

  play(): Promise<void> {
    this.paused = false
    return Promise.resolve()
  }

  pause(): void {
    this.paused = true
  }

  end(): void {
    this.paused = true
    this.onended?.()
  }
}

function transcriptionInfo(): Promise<{
  engine: 'whisper'
  modelId: string
  label: string
  language: string
  languages: { code: string; label: string }[]
  options: { id: string; name: string; active: boolean }[]
}> {
  return Promise.resolve({
    engine: 'whisper',
    modelId: 'whisper-small',
    label: 'Whisper Small',
    language: 'en',
    languages: [{ code: 'en', label: 'English' }],
    options: [{ id: 'whisper-small', name: 'Whisper Small', active: true }]
  })
}

function installMicrophone(): {
  getUserMedia: ReturnType<typeof vi.fn>
  stopTrack: ReturnType<typeof vi.fn>
} {
  const stopTrack = vi.fn()
  const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream
  const getUserMedia = vi.fn().mockResolvedValue(stream)
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia }
  })
  vi.stubGlobal('MediaRecorder', RecorderBoundary)
  vi.stubGlobal('AudioContext', AudioContextBoundary)
  return { getUserMedia, stopTrack }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('<MemoryChat/> Desktop voice turn modes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    RecorderBoundary.instances = []
    AudioBoundary.instances = []
    microphoneLevel = 0.01
    ;(Element.prototype as unknown as { scrollIntoView(): void }).scrollIntoView = () => {}
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      callback(0)
      return 1
    }
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:recorded-voice')
    })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Blob decoding is outside jsdom')))
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('uses the active transcription model for text dictation and lets the user cancel', async () => {
    installMicrophone()
    let resolveTranscript!: (text: string) => void
    const transcript = new Promise<string>((resolve) => {
      resolveTranscript = resolve
    })
    const boundary = new ChatBoundary()
    const transcribeAudio = vi
      .fn()
      .mockImplementationOnce(() => transcript)
      .mockResolvedValueOnce('This text came from the selected speech model')
    const getTranscriptionInfo = vi.fn(transcriptionInfo)
    Object.assign(boundary.api, { transcribeAudio, getTranscriptionInfo })
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-a' })

    await user.click(await screen.findByRole('button', { name: 'Record voice' }))
    await user.click(await screen.findByRole('button', { name: 'Stop recording' }))

    expect(await screen.findByRole('button', { name: 'Cancel transcription' })).toBeTruthy()
    expect(transcribeAudio).toHaveBeenCalledOnce()
    expect(getTranscriptionInfo).toHaveBeenCalledOnce()
    expect(boundary.calls).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Cancel transcription' }))
    resolveTranscript('This cancelled result must not appear')
    await flush()
    expect((screen.getByPlaceholderText(/Ask about/) as HTMLTextAreaElement).value).toBe('')

    await user.click(screen.getByRole('button', { name: 'Record voice' }))
    await user.click(screen.getByRole('button', { name: 'Stop recording' }))
    await waitFor(() =>
      expect((screen.getByPlaceholderText(/Ask about/) as HTMLTextAreaElement).value).toBe(
        'This text came from the selected speech model'
      )
    )
    expect(transcribeAudio).toHaveBeenCalledTimes(2)
  })

  it('shows all shared modes and Auto sends after speech ends in silence', async () => {
    const { getUserMedia } = installMicrophone()
    const boundary = new ChatBoundary()
    const transcribeAudio = vi.fn(async () => 'Schedule the planning review')
    Object.assign(boundary.api, {
      getSettings: vi.fn(async () => ({ composerVoiceMode: true })),
      transcribeAudio,
      getTranscriptionInfo: vi.fn(transcriptionInfo)
    })
    installBoundary(boundary)
    renderChat({ conversationId: 'conversation-a' })

    expect(await screen.findByRole('button', { name: 'Manual' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Auto' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Hands-free' })).toBeTruthy()

    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Auto' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start voice recording' }))
    await flush()
    expect(getUserMedia).toHaveBeenCalledOnce()

    act(() => vi.advanceTimersByTime(200))
    microphoneLevel = 0.2
    act(() => vi.advanceTimersByTime(200))
    microphoneLevel = 0.01
    act(() => vi.advanceTimersByTime(5_200))
    await flush()

    expect(transcribeAudio).toHaveBeenCalledOnce()
    expect(boundary.calls).toHaveLength(1)
    expect(boundary.calls[0]?.query).toBe('Schedule the planning review')
  })

  it('stops an active voice turn when the user returns to text mode', async () => {
    const { stopTrack } = installMicrophone()
    const boundary = new ChatBoundary()
    const transcribeAudio = vi.fn(async () => 'This turn was cancelled')
    Object.assign(boundary.api, {
      getSettings: vi.fn(async () => ({ composerVoiceMode: true })),
      transcribeAudio,
      getTranscriptionInfo: vi.fn(transcriptionInfo)
    })
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-a' })

    await user.click(await screen.findByRole('button', { name: 'Start voice recording' }))
    await user.click(screen.getByTitle('Voice mode on — speak and listen in voice notes'))

    await waitFor(() => expect(stopTrack).toHaveBeenCalledOnce())
    expect(screen.getByPlaceholderText(/Ask about/)).toBeTruthy()
    expect(transcribeAudio).not.toHaveBeenCalled()
  })

  it('keeps Hands-free off during the reply, rearms after playback, and can pause', async () => {
    const { getUserMedia } = installMicrophone()
    vi.stubGlobal('Audio', AudioBoundary)
    const boundary = new ChatBoundary()
    Object.assign(boundary.api, {
      getSettings: vi.fn(async () => ({ composerVoiceMode: true })),
      transcribeAudio: vi.fn(async () => 'What is on my schedule?'),
      getTranscriptionInfo: vi.fn(transcriptionInfo)
    })
    installBoundary(boundary)
    renderChat({ conversationId: 'conversation-a' })

    await screen.findByRole('button', { name: 'Hands-free' })
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Hands-free' }))
    await flush()
    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(screen.getByText('Waiting for your voice')).toBeTruthy()

    act(() => vi.advanceTimersByTime(200))
    microphoneLevel = 0.2
    act(() => vi.advanceTimersByTime(200))
    expect(screen.getByText('Recording you now')).toBeTruthy()
    microphoneLevel = 0.01
    act(() => vi.advanceTimersByTime(5_200))
    await flush()
    expect(boundary.calls).toHaveLength(1)

    boundary.resolve(0, 'You have a planning review at 10.')
    await flush()
    expect(boundary.speechTurns).toHaveLength(1)
    expect(getUserMedia).toHaveBeenCalledOnce()

    boundary.speechTurns[0]?.resolve({ dataUrl: 'data:audio/wav;base64,reply' })
    await flush()
    expect(AudioBoundary.instances).toHaveLength(1)
    expect(getUserMedia).toHaveBeenCalledOnce()

    AudioBoundary.instances[0]?.end()
    await flush()
    act(() => vi.advanceTimersByTime(1_999))
    expect(getUserMedia).toHaveBeenCalledOnce()
    act(() => vi.advanceTimersByTime(1))
    await flush()
    expect(getUserMedia).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('button', { name: 'Stop voice recording' }))
    expect(screen.getByText('Hands-free is paused - click to resume')).toBeTruthy()
    act(() => vi.advanceTimersByTime(10_000))
    await flush()
    expect(getUserMedia).toHaveBeenCalledTimes(2)
  })
})
