import { describe, expect, it } from 'vitest'
import type { VoiceTurnRequest } from '@offgrid/application'
import type { VoiceTurnHostMessage, VoiceTurnHostResult } from '../../shared/voice-turn-contract'
import { createVoiceTurnBroker, type VoiceTurnBrokerHost } from '../voice-turn-broker'

class RendererTurnBoundary implements VoiceTurnBrokerHost {
  private listener: ((result: VoiceTurnHostResult) => void) | null = null
  mode: 'complete' | 'fail' | 'hold' | 'throw' = 'complete'

  send(message: VoiceTurnHostMessage): void {
    if (this.mode === 'throw') throw new Error('The renderer transport closed.')
    if (message.type === 'run' && this.mode === 'complete') {
      queueMicrotask(() =>
        this.listener?.({
          requestId: message.requestId,
          status: 'completed',
          answer: `Answer to: ${message.text}`
        })
      )
    }
    if (message.type === 'run' && this.mode === 'fail') {
      queueMicrotask(() =>
        this.listener?.({
          requestId: message.requestId,
          status: 'failed',
          error: 'The chat turn failed.'
        })
      )
    }
    if (message.type === 'cancel') {
      queueMicrotask(() => this.listener?.({ requestId: message.requestId, status: 'cancelled' }))
    }
  }

  onResult(listener: (result: VoiceTurnHostResult) => void): () => void {
    this.listener = listener
    return () => {
      if (this.listener === listener) this.listener = null
    }
  }
}

const request = (signal = new AbortController().signal): VoiceTurnRequest => ({
  operationId: 'voice-operation',
  conversationId: 'conversation-1',
  turnId: 'turn-1',
  projectId: null,
  text: 'What changed today?',
  signal
})

describe('Desktop voice-turn renderer transport', () => {
  it('returns the answer completed by the renderer-owned chat turn', async () => {
    const host = new RendererTurnBoundary()
    const broker = createVoiceTurnBroker(host, () => 'request-1')

    await expect(broker.execute(request())).resolves.toEqual({
      answer: 'Answer to: What changed today?'
    })
    broker.dispose()
  })

  it('reports cancellation before and during a renderer turn', async () => {
    const host = new RendererTurnBoundary()
    host.mode = 'hold'
    const broker = createVoiceTurnBroker(host, () => 'request-2')
    const alreadyCancelled = new AbortController()
    alreadyCancelled.abort()

    await expect(broker.execute(request(alreadyCancelled.signal))).rejects.toThrow(
      'The voice turn was cancelled.'
    )

    const active = new AbortController()
    const result = broker.execute(request(active.signal))
    active.abort()
    await expect(result).rejects.toThrow('The voice turn was cancelled.')
    broker.dispose()
  })

  it('reports renderer transport failure and disposal of pending work', async () => {
    const host = new RendererTurnBoundary()
    host.mode = 'fail'
    const broker = createVoiceTurnBroker(host, () => 'request-3')
    await expect(broker.execute(request())).rejects.toThrow('The chat turn failed.')

    host.mode = 'throw'
    await expect(broker.execute(request())).rejects.toThrow('The renderer transport closed.')

    host.mode = 'hold'
    const pending = broker.execute(request())
    broker.dispose()
    await expect(pending).rejects.toThrow('The voice turn transport was disposed.')
  })
})
