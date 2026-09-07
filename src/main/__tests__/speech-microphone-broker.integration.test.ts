import { describe, expect, it } from 'vitest'
import type { RecordedAudio } from '@offgrid/speech'
import type {
  SpeechMicrophoneLevel,
  SpeechMicrophoneRequest,
  SpeechMicrophoneResult
} from '../../shared/speech-microphone-contract'
import {
  createSpeechMicrophoneBroker,
  type SpeechMicrophoneBroker,
  type SpeechMicrophoneBrokerHost
} from '../speech-microphone-broker'

const recordedAudio: RecordedAudio = {
  bytes: new Uint8Array([1, 2, 3]),
  mime: 'audio/wav',
  durationSeconds: 1.5
}

class RendererMicrophoneBoundary implements SpeechMicrophoneBrokerHost {
  private resultListener: ((rendererId: number, result: SpeechMicrophoneResult) => void) | null =
    null
  private levelListener: ((rendererId: number, level: SpeechMicrophoneLevel) => void) | null = null
  available = true
  mode: 'complete' | 'fail' | 'hold' | 'throw' = 'complete'

  rendererId(): number | null {
    return this.available ? 7 : null
  }

  send(rendererId: number, request: SpeechMicrophoneRequest): void {
    if (this.mode === 'throw') throw new Error('The renderer transport closed.')
    if (this.mode === 'hold') return

    const result: SpeechMicrophoneResult =
      this.mode === 'fail'
        ? {
            type: request.type,
            requestId: request.requestId,
            status: 'failed',
            error: 'Microphone permission was denied.'
          }
        : request.type === 'start'
          ? {
              type: 'start',
              requestId: request.requestId,
              status: 'completed',
              echoCancelled: true
            }
          : request.type === 'stop'
            ? {
                type: 'stop',
                requestId: request.requestId,
                status: 'completed',
                audio: recordedAudio
              }
            : { type: 'cancel', requestId: request.requestId, status: 'completed' }

    queueMicrotask(() => this.resultListener?.(rendererId, result))
  }

  onResult(listener: (rendererId: number, result: SpeechMicrophoneResult) => void): () => void {
    this.resultListener = listener
    return () => {
      if (this.resultListener === listener) this.resultListener = null
    }
  }

  onLevel(listener: (rendererId: number, level: SpeechMicrophoneLevel) => void): () => void {
    this.levelListener = listener
    return () => {
      if (this.levelListener === listener) this.levelListener = null
    }
  }

  emitLevel(captureId: string, rms: number): void {
    this.levelListener?.(7, { captureId, rms })
  }
}

const createBroker = (host: RendererMicrophoneBoundary): SpeechMicrophoneBroker => {
  let requestNumber = 0
  return createSpeechMicrophoneBroker(host, () => `capture-${++requestNumber}`)
}

describe('Desktop speech microphone renderer transport', () => {
  it('records audio and publishes levels from the active renderer capture', async () => {
    const host = new RendererMicrophoneBoundary()
    const broker = createBroker(host)
    const levels: number[] = []
    const offLevel = broker.onLevel((level) => levels.push(level))

    await broker.start()
    expect(broker.echoCancelled()).toBe(true)
    host.emitLevel('capture-1', 0.42)
    expect(levels).toEqual([0.42])
    await expect(broker.start()).rejects.toThrow('The speech microphone is already active.')

    await expect(broker.stop()).resolves.toEqual(recordedAudio)
    expect(broker.echoCancelled()).toBe(false)
    host.emitLevel('capture-1', 0.9)
    expect(levels).toEqual([0.42])
    await expect(broker.stop()).rejects.toThrow('The speech microphone is not active.')

    offLevel()
    broker.dispose()
  })

  it('cancels an active capture and treats cancellation while idle as complete', async () => {
    const host = new RendererMicrophoneBoundary()
    const broker = createBroker(host)

    await broker.start()
    await expect(broker.cancel()).resolves.toBeUndefined()
    await expect(broker.cancel()).resolves.toBeUndefined()
    broker.dispose()
  })

  it('reports unavailable, denied, and closed renderer boundaries', async () => {
    const unavailableHost = new RendererMicrophoneBoundary()
    unavailableHost.available = false
    const unavailableBroker = createBroker(unavailableHost)
    expect(() => unavailableBroker.start()).toThrow('Speech microphone renderer is unavailable.')
    unavailableBroker.dispose()

    const deniedHost = new RendererMicrophoneBoundary()
    deniedHost.mode = 'fail'
    const deniedBroker = createBroker(deniedHost)
    await expect(deniedBroker.start()).rejects.toThrow('Microphone permission was denied.')
    deniedBroker.dispose()

    const closedHost = new RendererMicrophoneBoundary()
    closedHost.mode = 'throw'
    const closedBroker = createBroker(closedHost)
    await expect(closedBroker.start()).rejects.toThrow('The renderer transport closed.')
    closedBroker.dispose()
  })

  it('rejects pending renderer work when the broker is disposed', async () => {
    const host = new RendererMicrophoneBoundary()
    host.mode = 'hold'
    const broker = createBroker(host)
    const pending = broker.start()
    const result = expect(pending).rejects.toThrow('Speech microphone broker was disposed.')

    broker.dispose()

    await result
  })
})
