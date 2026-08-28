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

  it('keeps the voice composer compact and Auto sends after speech ends in silence', async () => {
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

    expect(await screen.findByRole('group', { name: 'Voice mode' })).toBeTruthy()
    expect(screen.getByText('Manual')).toBeTruthy()
    expect(screen.getByText('Click the microphone to record')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Voice options' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Manual' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Voice settings' }))
    expect(await screen.findByRole('button', { name: 'Auto' })).toBeTruthy()

    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Auto' }))
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
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
    await user.click(screen.getByRole('button', { name: 'Voice' }))

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

    fireEvent.click(await screen.findByRole('button', { name: 'Voice settings' }))
    await screen.findByRole('button', { name: 'Hands-free' })
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Hands-free' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
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
    expect(screen.getByText('Paused - click the microphone to resume')).toBeTruthy()
    act(() => vi.advanceTimersByTime(10_000))
    await flush()
    expect(getUserMedia).toHaveBeenCalledTimes(2)
  })

  it('opens live voice reasoning and restores its collapse control when the reply completes', async () => {
    installMicrophone()
    const boundary = new ChatBoundary()
    Object.assign(boundary.api, {
      getSettings: vi.fn(async () => ({ composerVoiceMode: true })),
      transcribeAudio: vi.fn(async () => 'Check my calendar'),
      getTranscriptionInfo: vi.fn(transcriptionInfo)
    })
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-a' })

    await user.click(await screen.findByRole('button', { name: 'Start voice recording' }))
    await user.click(screen.getByRole('button', { name: 'Stop voice recording' }))
    await waitFor(() => expect(boundary.calls).toHaveLength(1))

    boundary.emitReasoning(0, 'Check the calendar before answering.')
    boundary.emit(0, 'You have a planning review at 10.')
    expect(await screen.findByText('Check the calendar before answering.')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Thinking…/ })).toBeTruthy()

    boundary.resolve(0, 'You have a planning review at 10.')
    await flush()
    const completedThought = await screen.findByRole('button', { name: /Thought process/i })
    expect(screen.queryByText('Check the calendar before answering.')).toBeNull()
    await user.click(completedThought)
    expect(await screen.findByText('Check the calendar before answering.')).toBeTruthy()
    await user.click(completedThought)
    expect(screen.queryByText('Check the calendar before answering.')).toBeNull()
  })

  it('shows when a remote voice turn returns no readable thinking details', async () => {
    installMicrophone()
    const boundary = new ChatBoundary()
    Object.assign(boundary.api, {
      getSettings: vi.fn(async () => ({ composerVoiceMode: true })),
      transcribeAudio: vi.fn(async () => 'Hello. How are you?'),
      getTranscriptionInfo: vi.fn(transcriptionInfo)
    })
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-a' })

    await user.click(await screen.findByRole('button', { name: 'Thinking' }))
    await user.click(screen.getByRole('button', { name: 'Start voice recording' }))
    await user.click(screen.getByRole('button', { name: 'Stop voice recording' }))
    await waitFor(() => expect(boundary.calls).toHaveLength(1))

    boundary.resolve(0, 'I am doing well. How can I help?')
    const unavailable = await screen.findByRole('button', { name: /Thinking unavailable/i })
    await user.click(unavailable)
    expect(
      await screen.findByText('This model did not return readable thinking details for this turn.')
    ).toBeTruthy()
  })

  it('keeps historical voice reasoning collapsed until the user opens it', async () => {
    const boundary = new ChatBoundary()
    boundary.messages['conversation-a'] = [
      {
        id: 1,
        role: 'assistant',
        content: '<think>Historical reasoning stays private.</think>The saved answer.'
      }
    ]
    Object.assign(boundary.api, {
      getSettings: vi.fn(async () => ({ composerVoiceMode: true }))
    })
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-a' })

    const thought = await screen.findByRole('button', { name: /Thought process/i })
    expect(screen.queryByText('Historical reasoning stays private.')).toBeNull()
    await user.click(thought)
    expect(await screen.findByText('Historical reasoning stays private.')).toBeTruthy()
  })

  it('resends a voice turn without adding a duplicate user message', async () => {
    const boundary = new ChatBoundary()
    boundary.messages['conversation-a'] = [
      {
        id: 1,
        role: 'user',
        content: 'Schedule the planning review'
      },
      { id: 2, role: 'assistant', content: 'The review is scheduled.' }
    ]
    boundary.conversations[0]!.message_count = 2
    Object.assign(boundary.api, {
      getSettings: vi.fn(async () => ({ composerVoiceMode: true }))
    })
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-a' })

    await user.click(await screen.findByRole('button', { name: 'Resend' }))
    await waitFor(() => expect(boundary.calls).toHaveLength(1))

    expect(boundary.calls[0]?.query).toBe('Schedule the planning review')
    expect(boundary.truncateRagMessages).toHaveBeenCalledWith('conversation-a', 1)
    expect(screen.getAllByRole('button', { name: 'Resend' })).toHaveLength(1)

    boundary.resolve(0, 'The review is scheduled again.')
    expect(await screen.findByText('The review is scheduled again.')).toBeTruthy()
    expect(screen.queryByText('The review is scheduled.')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Resend' })).toHaveLength(1)
    await waitFor(() =>
      expect(
        boundary.messages['conversation-a']!.map(({ role, content }) => [role, content])
      ).toEqual([
        ['user', 'Schedule the planning review'],
        ['assistant', 'The review is scheduled again.']
      ])
    )
  })

  it('shows Copied on a voice note, then returns to the copy action', async () => {
    const boundary = new ChatBoundary()
    boundary.messages['conversation-a'] = [
      { id: 1, role: 'assistant', content: 'Copy this voice reply.' }
    ]
    const writeClipboardText = vi.fn(async () => true)
    Object.assign(boundary.api, {
      getSettings: vi.fn(async () => ({ composerVoiceMode: true })),
      writeClipboardText
    })
    installBoundary(boundary)
    renderChat({ conversationId: 'conversation-a' })

    const copy = await screen.findByRole('button', { name: 'Copy transcript' })
    vi.useFakeTimers()
    fireEvent.click(copy)
    await flush()
    expect(writeClipboardText).toHaveBeenCalledWith('Copy this voice reply.')
    expect(screen.getByRole('status').textContent).toBe('Copied')

    act(() => vi.advanceTimersByTime(1_500))
    expect(screen.getByRole('button', { name: 'Copy transcript' })).toBeTruthy()
  })

  it('keeps the voice-note copy action available when both clipboard paths fail', async () => {
    const boundary = new ChatBoundary()
    boundary.messages['conversation-a'] = [
      { id: 1, role: 'assistant', content: 'Keep this copy action.' }
    ]
    const writeClipboardText = vi.fn(async () => {
      throw new Error('IPC unavailable')
    })
    const browserWrite = vi.fn(async () => {
      throw new Error('Clipboard unavailable')
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: browserWrite }
    })
    Object.assign(boundary.api, {
      getSettings: vi.fn(async () => ({ composerVoiceMode: true })),
      writeClipboardText
    })
    installBoundary(boundary)
    renderChat({ conversationId: 'conversation-a' })

    fireEvent.click(await screen.findByRole('button', { name: 'Copy transcript' }))
    await waitFor(() => expect(browserWrite).toHaveBeenCalledWith('Keep this copy action.'))
    expect(screen.getByRole('button', { name: 'Copy transcript' })).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  })
})
