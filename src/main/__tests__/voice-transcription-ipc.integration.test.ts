import { EventEmitter } from 'events'
import fs from 'fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptionService } from '../transcription/types'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import {
  setupVoiceTranscriptionIpc,
  type VoiceTranscriptionIpcHost
} from '../voice-transcription-ipc'

type Handler = Parameters<VoiceTranscriptionIpcHost['handle']>[1]

class IpcHost implements VoiceTranscriptionIpcHost {
  readonly handlers = new Map<string, Handler>()

  handle(channel: string, listener: Handler): void {
    this.handlers.set(channel, listener)
  }

  invoke(channel: string, event: unknown, ...args: unknown[]): unknown {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error(`No handler for ${channel}`)
    return handler(event as never, ...args)
  }
}

class Sender extends EventEmitter {
  constructor(readonly id: number) {
    super()
  }
}

const event = (sender: Sender): unknown => ({ sender })

describe('voice transcription IPC request lifecycle', () => {
  let host: IpcHost

  beforeEach(() => {
    host = new IpcHost()
  })

  it('aborts the active native request for the same renderer and removes its temp audio', async () => {
    let inputPath = ''
    let receivedSignal: AbortSignal | undefined
    let started!: () => void
    const didStart = new Promise<void>((resolve) => {
      started = resolve
    })
    const service: TranscriptionService = {
      isAvailable: () => true,
      async transcribe(input, options) {
        inputPath = input.path
        receivedSignal = options?.signal
        started()
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted', 'AbortError')),
            { once: true }
          )
        })
      }
    }
    setupVoiceTranscriptionIpc(host, async () => service)
    const owner = new Sender(7)
    const stranger = new Sender(8)

    const transcription = host.invoke(
      'voice:transcribe',
      event(owner),
      new Uint8Array([1, 2, 3]),
      'webm',
      'voice-request-1'
    ) as Promise<string>
    await didStart

    expect(fs.existsSync(inputPath)).toBe(true)
    expect(host.invoke('voice:cancel-transcription', event(stranger), 'voice-request-1')).toBe(
      false
    )
    expect(host.invoke('voice:cancel-transcription', event(owner), 'voice-request-1')).toBe(true)
    await expect(transcription).rejects.toMatchObject({ name: 'AbortError' })
    expect(receivedSignal?.aborted).toBe(true)
    expect(fs.existsSync(inputPath)).toBe(false)
    expect(host.invoke('voice:cancel-transcription', event(owner), 'voice-request-1')).toBe(false)
  })

  it('returns the transcript and removes temp audio after normal completion', async () => {
    let inputPath = ''
    const service: TranscriptionService = {
      isAvailable: () => true,
      async transcribe(input) {
        inputPath = input.path
        expect(await fs.promises.readFile(input.path)).toEqual(Buffer.from([4, 5]))
        return { text: 'hello from the native runtime' }
      }
    }
    setupVoiceTranscriptionIpc(host, async () => service)
    const sender = new Sender(11)

    await expect(
      host.invoke(
        'voice:transcribe',
        event(sender),
        new Uint8Array([0, 4, 5, 9]).subarray(1, 3),
        'wav',
        'voice-request-2'
      )
    ).resolves.toBe('hello from the native runtime')
    expect(fs.existsSync(inputPath)).toBe(false)
  })
})
