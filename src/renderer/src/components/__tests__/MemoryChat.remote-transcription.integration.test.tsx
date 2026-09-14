// @vitest-environment jsdom

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { transcribeRemoteAudio } from '../../../../main/remote-media-runtime'
import { ChatBoundary, installBoundary, renderChat } from './harness/chat-boundary'

class MicrophoneRecording {
  static isTypeSupported(): boolean { return true }
  state: RecordingState = 'inactive'
  mimeType = 'audio/webm'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null

  start(): void {
    this.state = 'recording'
    this.ondataavailable?.({ data: new Blob(['spoken words'], { type: this.mimeType }) })
  }

  stop(): void {
    this.state = 'inactive'
    this.onstop?.()
  }
}

class MicrophoneAudioContext {
  createMediaStreamSource(): { connect(): void } { return { connect() {} } }
  createAnalyser(): AnalyserNode {
    return { fftSize: 2048, getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.01) } as unknown as AnalyserNode
  }
  close(): Promise<void> { return Promise.resolve() }
}

const originalRecorder = globalThis.MediaRecorder
const originalContext = globalThis.AudioContext
const originalFetch = globalThis.fetch
const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
const originalCreateObjectURL = URL.createObjectURL

afterEach(() => {
  cleanup()
  globalThis.MediaRecorder = originalRecorder
  globalThis.AudioContext = originalContext
  globalThis.fetch = originalFetch
  if (originalMediaDevices) Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices)
  else delete (navigator as { mediaDevices?: MediaDevices }).mediaDevices
  URL.createObjectURL = originalCreateObjectURL
})

describe('<MemoryChat/> with a remote transcription provider', () => {
  it('puts the provider transcript into the message composer', async () => {
    let receivedFile: { model: FormDataEntryValue | null; name: string; size: number } | null = null
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-transcription-ui-'))
    try {
      const server: Parameters<typeof transcribeRemoteAudio>[0] = {
        id: 'transcription-server', name: 'Transcription provider', provider: 'custom',
        endpoint: 'https://provider.test/v1', model: '', enabled: true,
        mediaModels: { transcription: 'listener' }, modelCatalog: [],
        screenFramesAllowed: false, apiKey: '', selectedModel: 'listener'
      }
      globalThis.MediaRecorder = MicrophoneRecording as unknown as typeof MediaRecorder
      globalThis.AudioContext = MicrophoneAudioContext as unknown as typeof AudioContext
      globalThis.fetch = async (_input, options) => {
        const form = options?.body as FormData
        const file = form.get('file') as File
        receivedFile = { model: form.get('model'), name: file.name, size: file.size }
        return {
          ok: true,
          status: 200,
          json: async () => ({ text: 'Plan the next meeting', language: 'en' })
        } as Response
      }
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) }
      })
      URL.createObjectURL = () => 'blob:recorded-voice'
      ;(Element.prototype as unknown as { scrollIntoView(): void }).scrollIntoView = () => {}
      globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
        callback(0)
        return 1
      }
      const boundary = new ChatBoundary()
      installBoundary(boundary)
      window.api.getTranscriptionInfo = async () => ({
        engine: 'whisper', modelId: 'remote-listener', label: 'Remote listener', language: 'en',
        languages: [{ code: 'en', label: 'English' }],
        options: [{ id: 'remote-listener', name: 'Remote listener', active: true }]
      })
      window.api.transcribeAudio = async (bytes) => {
        const file = path.join(temporary, 'voice.webm')
        fs.writeFileSync(file, Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes))
        return (await transcribeRemoteAudio(server, file)).text
      }
      window.api.cancelTranscription = async () => true
      renderChat({ conversationId: 'conversation-a' })
      const user = userEvent.setup()
      await user.click(await screen.findByRole('button', { name: 'Record voice' }))
      await user.click(await screen.findByRole('button', { name: 'Stop recording' }))
      await waitFor(() =>
        expect((screen.getByPlaceholderText(/Ask about/) as HTMLTextAreaElement).value).toBe('Plan the next meeting')
      )
      expect(receivedFile).toEqual({ model: 'listener', name: 'voice.webm', size: 12 })
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true })
    }
  })
})
