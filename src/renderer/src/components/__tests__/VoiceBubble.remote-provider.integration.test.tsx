// @vitest-environment jsdom

import { createServer } from 'node:http'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { synthesizeRemoteVoice } from '../../../../main/remote-media-runtime'
import { VoiceBubble } from '../VoiceBubble'

class AudioOutput {
  paused = true
  playbackRate = 1
  currentTime = 0
  duration = 1
  ontimeupdate: (() => void) | null = null
  onloadedmetadata: (() => void) | null = null
  onended: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly src: string) {}

  async play(): Promise<void> { this.paused = false }
  pause(): void { this.paused = true }
}

const originalAudio = globalThis.Audio
afterEach(() => {
  cleanup()
  globalThis.Audio = originalAudio
})

describe('<VoiceBubble/> with a remote voice provider', () => {
  it('plays speech returned by the selected provider voice', async () => {
    let spokenText = ''
    const provider = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { input: string; voice: string }
      spokenText = `${body.voice}: ${body.input}`
      response.writeHead(200, { 'Content-Type': 'audio/mpeg' })
      response.end(Buffer.from('synthetic speech bytes'))
    })
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
    try {
      const address = provider.address()
      if (!address || typeof address === 'string') throw new Error('Test provider has no port')
      const server: Parameters<typeof synthesizeRemoteVoice>[0] = {
        id: 'voice-server', name: 'Voice provider', provider: 'custom',
        endpoint: `http://127.0.0.1:${address.port}/v1`, model: '', enabled: true,
        mediaModels: { voice: 'voice-maker' }, modelCatalog: [],
        screenFramesAllowed: false, apiKey: '', selectedModel: 'voice-maker'
      }
      globalThis.Audio = AudioOutput as unknown as typeof Audio
      render(<VoiceBubble
        messageId="reply"
        transcript="Hello from the model"
        readVoice={async () => 'alloy'}
        synthesize={(text, voice) => synthesizeRemoteVoice(server, text, voice)}
      />)
      await userEvent.setup().click(screen.getByTitle('Play'))
      await waitFor(() => expect(screen.getByTitle('Pause')).toBeTruthy())
      expect(spokenText).toBe('alloy: Hello from the model')
    } finally {
      await new Promise<void>((resolve) => provider.close(() => resolve()))
    }
  })
})
