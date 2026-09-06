import type {
  SpeechPlaybackRequest,
  SpeechPlaybackResult
} from '../../../shared/speech-playback-contract'

export interface RendererSpeechPlaybackBridge {
  onRequest(listener: (request: SpeechPlaybackRequest) => void): () => void
  sendResult(result: SpeechPlaybackResult): void
}

interface ActivePlayback {
  audio: HTMLAudioElement
  requestId: string
  settled: boolean
}

function sourceOf(request: Extract<SpeechPlaybackRequest, { type: 'play' }>): string | null {
  if (request.audio.kind === 'inline') return request.audio.dataUri
  if (request.audio.kind === 'file') return request.audio.path
  return null
}

export function attachSpeechPlaybackAdapter(
  bridge: RendererSpeechPlaybackBridge,
  createAudio: (source: string) => HTMLAudioElement = (source) => new Audio(source)
): () => void {
  let active: ActivePlayback | null = null

  const finish = (playback: ActivePlayback, result: SpeechPlaybackResult): void => {
    if (playback.settled) return
    playback.settled = true
    playback.audio.onended = null
    playback.audio.onerror = null
    playback.audio.pause()
    playback.audio.removeAttribute('src')
    playback.audio.load()
    if (active === playback) active = null
    bridge.sendResult(result)
  }

  const cancel = (playback: ActivePlayback): void => {
    finish(playback, { requestId: playback.requestId, status: 'cancelled' })
  }

  const play = (request: Extract<SpeechPlaybackRequest, { type: 'play' }>): void => {
    if (active) cancel(active)
    const source = sourceOf(request)
    if (!source) {
      bridge.sendResult({
        requestId: request.requestId,
        status: 'failed',
        error: 'The speech engine did not provide playable audio.'
      })
      return
    }

    const playback: ActivePlayback = {
      audio: createAudio(source),
      requestId: request.requestId,
      settled: false
    }
    active = playback
    playback.audio.onended = () => {
      finish(playback, { requestId: request.requestId, status: 'completed' })
    }
    playback.audio.onerror = () => {
      finish(playback, {
        requestId: request.requestId,
        status: 'failed',
        error: 'Speech playback failed.'
      })
    }
    void playback.audio.play().catch((error: unknown) => {
      finish(playback, {
        requestId: request.requestId,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error)
      })
    })
  }

  const offRequest = bridge.onRequest((request) => {
    if (request.type === 'play') play(request)
    else if (active?.requestId === request.requestId) cancel(active)
  })

  return () => {
    offRequest()
    if (active) cancel(active)
  }
}
