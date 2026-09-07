import { describe, expect, it } from 'vitest'
import type { SynthesizedAudio } from '@offgrid/speech'
import type {
  SpeechPlaybackRequest,
  SpeechPlaybackResult
} from '../../shared/speech-playback-contract'
import {
  createSpeechPlaybackBroker,
  type SpeechPlaybackBrokerHost
} from '../speech-playback-broker'

class RendererPlaybackBoundary implements SpeechPlaybackBrokerHost {
  private listener: ((result: SpeechPlaybackResult) => void) | null = null
  mode: 'complete' | 'fail' | 'hold' | 'throw' = 'complete'

  send(request: SpeechPlaybackRequest): void {
    if (this.mode === 'throw') throw new Error('The renderer transport closed.')
    if (request.type !== 'play') return

    if (this.mode === 'complete') {
      queueMicrotask(() => this.listener?.({ requestId: request.requestId, status: 'completed' }))
    }
    if (this.mode === 'fail') {
      queueMicrotask(() =>
        this.listener?.({
          requestId: request.requestId,
          status: 'failed',
          error: 'The audio device rejected playback.'
        })
      )
    }
  }

  onResult(listener: (result: SpeechPlaybackResult) => void): () => void {
    this.listener = listener
    return () => {
      if (this.listener === listener) this.listener = null
    }
  }
}

const audio: SynthesizedAudio = {
  kind: 'inline',
  dataUri: 'data:audio/wav;base64,UklGRg=='
}

describe('Desktop speech playback renderer transport', () => {
  it('completes when the renderer finishes playing synthesized audio', async () => {
    const host = new RendererPlaybackBoundary()
    const broker = createSpeechPlaybackBroker(host, () => 'playback-1')

    await expect(broker.play(audio, new AbortController().signal)).resolves.toBeUndefined()
    broker.dispose()
  })

  it('reports cancellation before and during playback', async () => {
    const host = new RendererPlaybackBoundary()
    host.mode = 'hold'
    const broker = createSpeechPlaybackBroker(host, () => 'playback-2')
    const alreadyCancelled = new AbortController()
    alreadyCancelled.abort(new Error('The user cancelled playback.'))

    await expect(broker.play(audio, alreadyCancelled.signal)).rejects.toThrow(
      'The user cancelled playback.'
    )

    const active = new AbortController()
    const result = broker.play(audio, active.signal)
    active.abort(new Error('The active playback was cancelled.'))
    await expect(result).rejects.toThrow('The active playback was cancelled.')
    broker.dispose()
  })

  it('reports renderer playback and transport failures', async () => {
    const host = new RendererPlaybackBoundary()
    host.mode = 'fail'
    const broker = createSpeechPlaybackBroker(host, () => 'playback-3')

    await expect(broker.play(audio, new AbortController().signal)).rejects.toThrow(
      'The audio device rejected playback.'
    )

    host.mode = 'throw'
    await expect(broker.play(audio, new AbortController().signal)).rejects.toThrow(
      'The renderer transport closed.'
    )
    broker.dispose()
  })

  it('stops every active playback when the broker is disposed', async () => {
    const host = new RendererPlaybackBoundary()
    host.mode = 'hold'
    let requestNumber = 0
    const broker = createSpeechPlaybackBroker(host, () => `playback-${++requestNumber}`)
    const first = broker.play(audio, new AbortController().signal)
    const second = broker.play(audio, new AbortController().signal)
    const firstResult = expect(first).rejects.toThrow('Speech playback was cancelled.')
    const secondResult = expect(second).rejects.toThrow('Speech playback was cancelled.')

    broker.dispose()

    await Promise.all([firstResult, secondResult])
  })
})
