/**
 * The turn executor `askByVoice` calls, as a transport rather than a second turn implementation.
 *
 * Seat C's seam takes `(request) => Promise<{ answer }>` and says `DesktopChatSession.send`
 * satisfies it. On desktop that session lives in the RENDERER - it owns the persisted rows, the
 * retrieval context the transcript discloses, the tool loop, the image hand-off and the variants -
 * while the workflow runs in main with the facades. So the executor composed in main asks the
 * renderer to run its own turn and waits for the answer. Writing a main-side turn instead would
 * have been a third implementation of the thing this whole item exists to unify.
 *
 * Pure over an injected host, no Electron: the same shape as the speech playback broker, which
 * already inverts this direction for the same reason.
 */
import { randomUUID } from 'node:crypto'
import type { VoiceTurnExecutor, VoiceTurnRequest, VoiceTurnResult } from '@offgrid/application'
import type { VoiceTurnHostMessage, VoiceTurnHostResult } from '../shared/voice-turn-contract'

export interface VoiceTurnBrokerHost {
  send(message: VoiceTurnHostMessage): void
  onResult(listener: (result: VoiceTurnHostResult) => void): () => void
}

interface PendingTurn {
  resolve(result: VoiceTurnResult): void
  reject(error: Error): void
  readonly signal: AbortSignal
  onAbort(): void
}

export interface VoiceTurnBroker {
  readonly execute: VoiceTurnExecutor
  dispose(): void
}

const cancelled = (): Error => new Error('The voice turn was cancelled.')

export function createVoiceTurnBroker(
  host: VoiceTurnBrokerHost,
  newId: () => string = randomUUID
): VoiceTurnBroker {
  const pending = new Map<string, PendingTurn>()

  const settle = (result: VoiceTurnHostResult): void => {
    const turn = pending.get(result.requestId)
    if (!turn) return
    pending.delete(result.requestId)
    turn.signal.removeEventListener('abort', turn.onAbort)
    if (result.status === 'completed') turn.resolve({ answer: result.answer })
    else if (result.status === 'failed') turn.reject(new Error(result.error))
    else turn.reject(cancelled())
  }

  /**
   * The run's signal is the ONLY cancellation. The workflow suppresses its own `models.cancel` for
   * an executor-run turn, so this is the single stop for one turn: tell the renderer, and let it
   * end the turn it owns. We do not settle here - the renderer reports how its turn actually ended,
   * and its rows are its own to keep.
   */
  const requestCancel = (requestId: string): void => {
    if (!pending.has(requestId)) return
    try {
      host.send({ type: 'cancel', requestId })
    } catch (error) {
      settle({
        requestId,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const offResult = host.onResult(settle)

  return {
    execute: (request: VoiceTurnRequest): Promise<VoiceTurnResult> => {
      if (request.signal.aborted) return Promise.reject(cancelled())
      const requestId = newId()
      return new Promise<VoiceTurnResult>((resolve, reject) => {
        const onAbort = (): void => requestCancel(requestId)
        pending.set(requestId, { resolve, reject, signal: request.signal, onAbort })
        request.signal.addEventListener('abort', onAbort, { once: true })
        try {
          host.send({
            type: 'run',
            requestId,
            operationId: request.operationId,
            conversationId: request.conversationId,
            turnId: request.turnId,
            projectId: request.projectId,
            text: request.text
          })
        } catch (error) {
          settle({
            requestId,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error)
          })
        }
      })
    },
    dispose: (): void => {
      offResult()
      for (const [requestId, turn] of [...pending]) {
        pending.delete(requestId)
        turn.signal.removeEventListener('abort', turn.onAbort)
        turn.reject(new Error('The voice turn transport was disposed.'))
      }
    }
  }
}
