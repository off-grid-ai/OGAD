import type {
  SpeechTextCleanRequest,
  SpeechTextCleanResult
} from '../../../shared/speech-text-cleaning-contract'
import { toSpeakableText } from '../lib/speakable'

export interface RendererSpeechTextCleaningBridge {
  onRequest(listener: (request: SpeechTextCleanRequest) => void): () => void
  sendResult(result: SpeechTextCleanResult): void
}

export function attachSpeechTextCleaningAdapter(
  bridge: RendererSpeechTextCleaningBridge
): () => void {
  const active = new Map<string, { cancelled: boolean }>()
  const finish = (requestId: string, result: SpeechTextCleanResult): void => {
    if (!active.delete(requestId)) return
    bridge.sendResult(result)
  }
  const offRequest = bridge.onRequest((request) => {
    if (request.type === 'cancel') {
      const operation = active.get(request.requestId)
      if (operation) operation.cancelled = true
      finish(request.requestId, { requestId: request.requestId, status: 'cancelled' })
      return
    }
    if (active.has(request.requestId)) return
    const operation = { cancelled: false }
    active.set(request.requestId, operation)
    void Promise.resolve()
      .then(() => toSpeakableText(request.text))
      .then((text) => {
        if (!operation.cancelled) {
          finish(request.requestId, { requestId: request.requestId, status: 'completed', text })
        }
      })
      .catch((error: unknown) => {
        finish(request.requestId, {
          requestId: request.requestId,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error)
        })
      })
  })

  return () => {
    offRequest()
    for (const requestId of active.keys()) {
      finish(requestId, { requestId, status: 'cancelled' })
    }
  }
}
