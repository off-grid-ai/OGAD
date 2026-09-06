import { randomUUID } from 'node:crypto'
import type { PlaybackPort, SynthesizedAudio, Unsubscribe } from '@offgrid/speech'
import type {
  SpeechPlaybackRequest,
  SpeechPlaybackResult
} from '../shared/speech-playback-contract'

export interface SpeechPlaybackBrokerHost {
  send(request: SpeechPlaybackRequest): void
  onResult(listener: (result: SpeechPlaybackResult) => void): Unsubscribe
}

interface PendingPlayback {
  reject(error: Error): void
  resolve(): void
  signal: AbortSignal
  onAbort(): void
}

export interface SpeechPlaybackBroker extends PlaybackPort {
  dispose(): void
}

function cancellationError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error('Speech playback was cancelled.')
}

export function createSpeechPlaybackBroker(
  host: SpeechPlaybackBrokerHost,
  newId: () => string = randomUUID
): SpeechPlaybackBroker {
  const pending = new Map<string, PendingPlayback>()

  const settle = (requestId: string, result: SpeechPlaybackResult): void => {
    const playback = pending.get(requestId)
    if (!playback) return
    pending.delete(requestId)
    playback.signal.removeEventListener('abort', playback.onAbort)
    if (result.status === 'completed') playback.resolve()
    else if (result.status === 'failed') playback.reject(new Error(result.error))
    else playback.reject(cancellationError(playback.signal))
  }

  const stopRequest = (requestId: string): void => {
    const playback = pending.get(requestId)
    if (!playback) return
    try {
      host.send({ type: 'stop', requestId })
      settle(requestId, { requestId, status: 'cancelled' })
    } catch (error) {
      settle(requestId, {
        requestId,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const offResult = host.onResult((result) => settle(result.requestId, result))

  return {
    play(audio: SynthesizedAudio, signal: AbortSignal): Promise<void> {
      if (signal.aborted) return Promise.reject(cancellationError(signal))
      const requestId = newId()
      return new Promise<void>((resolve, reject) => {
        const onAbort = (): void => stopRequest(requestId)
        pending.set(requestId, { resolve, reject, signal, onAbort })
        signal.addEventListener('abort', onAbort, { once: true })
        try {
          host.send({ type: 'play', requestId, audio })
        } catch (error) {
          settle(requestId, {
            requestId,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error)
          })
        }
      })
    },
    stop(): void {
      for (const requestId of [...pending.keys()]) stopRequest(requestId)
    },
    dispose(): void {
      offResult()
      for (const requestId of [...pending.keys()]) stopRequest(requestId)
    }
  }
}
