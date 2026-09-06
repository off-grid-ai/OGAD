import { randomUUID } from 'node:crypto'
import type { MicrophonePort, RecordedAudio, Unsubscribe } from '@offgrid/speech'
import type {
  SpeechMicrophoneLevel,
  SpeechMicrophoneRequest,
  SpeechMicrophoneResult
} from '../shared/speech-microphone-contract'

export interface SpeechMicrophoneBrokerHost {
  rendererId(): number | null
  send(rendererId: number, request: SpeechMicrophoneRequest): void
  onResult(listener: (rendererId: number, result: SpeechMicrophoneResult) => void): Unsubscribe
  onLevel(listener: (rendererId: number, level: SpeechMicrophoneLevel) => void): Unsubscribe
}

type PendingRequest =
  | { type: 'start'; resolve(): void; reject(error: Error): void }
  | { type: 'stop'; resolve(audio: RecordedAudio): void; reject(error: Error): void }
  | { type: 'cancel'; resolve(): void; reject(error: Error): void }

interface Capture {
  id: string
  ownerId: number
  echoCancelled: boolean
}

export interface SpeechMicrophoneBroker extends MicrophonePort {
  dispose(): void
}

type MicrophoneFailureResult = Extract<SpeechMicrophoneResult, { status: 'failed' | 'cancelled' }>

const failureOf = (result: MicrophoneFailureResult): Error =>
  new Error(
    result.error ??
      (result.status === 'cancelled'
        ? 'Microphone request was cancelled.'
        : 'Microphone request failed.')
  )

export function createSpeechMicrophoneBroker(
  host: SpeechMicrophoneBrokerHost,
  newId: () => string = randomUUID
): SpeechMicrophoneBroker {
  const pending = new Map<string, PendingRequest>()
  const levelListeners = new Set<(rms: number) => void>()
  let capture: Capture | null = null

  const failSend = (requestId: string, cause: unknown): void => {
    const request = pending.get(requestId)
    if (!request) return
    pending.delete(requestId)
    if (request.type === 'start' && capture?.id === requestId) capture = null
    request.reject(cause instanceof Error ? cause : new Error(String(cause)))
  }

  const onResult = (rendererId: number, result: SpeechMicrophoneResult): void => {
    const request = pending.get(result.requestId)
    if (!request || request.type !== result.type || capture?.ownerId !== rendererId) return
    pending.delete(result.requestId)
    if (result.status !== 'completed') {
      if (request.type === 'start' || request.type === 'stop') capture = null
      request.reject(failureOf(result))
      return
    }
    if (result.type === 'start' && request.type === 'start') {
      capture.echoCancelled = result.echoCancelled
      request.resolve()
    } else if (result.type === 'stop' && request.type === 'stop') {
      capture = null
      request.resolve(result.audio)
    } else if (result.type === 'cancel' && request.type === 'cancel') {
      capture = null
      request.resolve()
    }
  }

  const offResult = host.onResult(onResult)
  const offLevel = host.onLevel((rendererId, level) => {
    if (!capture || rendererId !== capture.ownerId || level.captureId !== capture.id) return
    for (const listener of levelListeners) listener(level.rms)
  })

  const owner = (): number => {
    const rendererId = host.rendererId()
    if (rendererId === null) throw new Error('Speech microphone renderer is unavailable.')
    return rendererId
  }

  const send = (rendererId: number, request: SpeechMicrophoneRequest): void => {
    try {
      host.send(rendererId, request)
    } catch (error) {
      failSend(request.requestId, error)
    }
  }

  return {
    start(): Promise<void> {
      if (capture) return Promise.reject(new Error('The speech microphone is already active.'))
      const requestId = newId()
      const ownerId = owner()
      capture = { id: requestId, ownerId, echoCancelled: false }
      return new Promise<void>((resolve, reject) => {
        pending.set(requestId, { type: 'start', resolve, reject })
        send(ownerId, { type: 'start', requestId })
      })
    },
    stop(): Promise<RecordedAudio> {
      if (!capture) return Promise.reject(new Error('The speech microphone is not active.'))
      const { id: captureId, ownerId } = capture
      const requestId = newId()
      return new Promise<RecordedAudio>((resolve, reject) => {
        pending.set(requestId, { type: 'stop', resolve, reject })
        send(ownerId, { type: 'stop', requestId, captureId })
      })
    },
    cancel(): Promise<void> {
      if (!capture) return Promise.resolve()
      const { id: captureId, ownerId } = capture
      const requestId = newId()
      return new Promise<void>((resolve, reject) => {
        pending.set(requestId, { type: 'cancel', resolve, reject })
        send(ownerId, { type: 'cancel', requestId, captureId })
      })
    },
    onLevel(listener: (rms: number) => void): Unsubscribe {
      levelListeners.add(listener)
      return () => levelListeners.delete(listener)
    },
    echoCancelled: () => capture?.echoCancelled ?? false,
    dispose(): void {
      if (capture) {
        try {
          host.send(capture.ownerId, { type: 'cancel', requestId: newId(), captureId: capture.id })
        } catch {
          // Pending callers receive the terminal disposal failure below.
        }
      }
      capture = null
      const error = new Error('Speech microphone broker was disposed.')
      for (const request of pending.values()) request.reject(error)
      pending.clear()
      levelListeners.clear()
      offResult()
      offLevel()
    }
  }
}
