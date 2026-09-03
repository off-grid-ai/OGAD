import { chooseRecorderMime } from '@offgrid/speech'
import type {
  SpeechMicrophoneLevel,
  SpeechMicrophoneRequest,
  SpeechMicrophoneResult
} from '../../../shared/speech-microphone-contract'

export interface RendererSpeechMicrophoneBridge {
  onRequest(listener: (request: SpeechMicrophoneRequest) => void): () => void
  sendResult(result: SpeechMicrophoneResult): void
  sendLevel(level: SpeechMicrophoneLevel): void
}

interface Capture {
  captureId: string
  chunks: Blob[]
  context: AudioContext
  interval: ReturnType<typeof setInterval>
  recorder: MediaRecorder
  startedAt: number
  stream: MediaStream
}

const LEVEL_INTERVAL_MS = 50

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

function recorderMime(): string {
  return chooseRecorderMime((mime) => MediaRecorder.isTypeSupported(mime))
}

async function closeCapture(capture: Capture, stopRecorder: boolean): Promise<void> {
  clearInterval(capture.interval)
  if (stopRecorder && capture.recorder.state !== 'inactive') capture.recorder.stop()
  capture.recorder.ondataavailable = null
  capture.recorder.onstop = null
  capture.recorder.onerror = null
  capture.stream.getTracks().forEach((track) => track.stop())
  if (capture.context.state !== 'closed') await capture.context.close()
}

function stopRecording(capture: Capture): Promise<void> {
  if (capture.recorder.state === 'inactive') return Promise.resolve()
  return new Promise((resolve, reject) => {
    capture.recorder.onstop = () => resolve()
    capture.recorder.onerror = () => reject(new Error('Microphone recording failed to stop.'))
    capture.recorder.stop()
  })
}

export function attachSpeechMicrophoneAdapter(bridge: RendererSpeechMicrophoneBridge): () => void {
  let active: Capture | null = null
  let startSequence = 0

  const result = (terminal: SpeechMicrophoneResult): void => bridge.sendResult(terminal)

  const release = async (capture: Capture, stopRecorder: boolean): Promise<void> => {
    if (active === capture) active = null
    await closeCapture(capture, stopRecorder)
  }

  const start = async (
    request: Extract<SpeechMicrophoneRequest, { type: 'start' }>
  ): Promise<void> => {
    const sequence = ++startSequence
    let openingStream: MediaStream | null = null
    let openingContext: AudioContext | null = null
    try {
      if (active) await release(active, true)
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
      openingStream = stream
      if (sequence !== startSequence) {
        stream.getTracks().forEach((track) => track.stop())
        openingStream = null
        result({ type: 'start', requestId: request.requestId, status: 'cancelled' })
        return
      }

      const mime = recorderMime()
      const recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream)
      const context = new AudioContext()
      openingContext = context
      const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      source.connect(analyser)
      const samples = new Float32Array(analyser.fftSize)
      const interval = setInterval(() => {
        analyser.getFloatTimeDomainData(samples)
        let sum = 0
        for (const sample of samples) sum += sample * sample
        const rms = Math.min(1, Math.max(0, Math.sqrt(sum / samples.length)))
        bridge.sendLevel({ captureId: request.requestId, rms })
      }, LEVEL_INTERVAL_MS)
      const capture: Capture = {
        captureId: request.requestId,
        chunks: [],
        context,
        interval,
        recorder,
        startedAt: Date.now(),
        stream
      }
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) capture.chunks.push(event.data)
      }
      active = capture
      openingStream = null
      openingContext = null
      recorder.start()
      const echoCancelled = stream
        .getAudioTracks()
        .every((track) => track.getSettings().echoCancellation === true)
      result({ type: 'start', requestId: request.requestId, status: 'completed', echoCancelled })
    } catch (error) {
      let detail = messageOf(error)
      openingStream?.getTracks().forEach((track) => track.stop())
      try {
        if (openingContext && openingContext.state !== 'closed') await openingContext.close()
        if (active?.captureId === request.requestId) await release(active, true)
      } catch (cleanupError) {
        detail = `${detail} Microphone cleanup failed: ${messageOf(cleanupError)}`
      }
      result({
        type: 'start',
        requestId: request.requestId,
        status: 'failed',
        error: detail
      })
    }
  }

  const stop = async (
    request: Extract<SpeechMicrophoneRequest, { type: 'stop' }>
  ): Promise<void> => {
    const capture = active
    if (!capture || capture.captureId !== request.captureId) {
      result({
        type: 'stop',
        requestId: request.requestId,
        status: 'failed',
        error: 'Microphone capture is not active.'
      })
      return
    }
    try {
      await stopRecording(capture)
      const blob = new Blob(capture.chunks, { type: capture.recorder.mimeType || 'audio/webm' })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      await release(capture, false)
      result({
        type: 'stop',
        requestId: request.requestId,
        status: 'completed',
        audio: {
          bytes,
          mime: blob.type,
          durationSeconds: Math.max(0, (Date.now() - capture.startedAt) / 1000)
        }
      })
    } catch (error) {
      let detail = messageOf(error)
      try {
        await release(capture, true)
      } catch (cleanupError) {
        detail = `${detail} Microphone cleanup failed: ${messageOf(cleanupError)}`
      }
      result({ type: 'stop', requestId: request.requestId, status: 'failed', error: detail })
    }
  }

  const cancel = async (
    request: Extract<SpeechMicrophoneRequest, { type: 'cancel' }>
  ): Promise<void> => {
    const capture = active
    if (!capture || capture.captureId !== request.captureId) {
      result({
        type: 'cancel',
        requestId: request.requestId,
        status: 'failed',
        error: 'Microphone capture is not active.'
      })
      return
    }
    try {
      await release(capture, true)
      result({ type: 'cancel', requestId: request.requestId, status: 'completed' })
    } catch (error) {
      result({
        type: 'cancel',
        requestId: request.requestId,
        status: 'failed',
        error: messageOf(error)
      })
    }
  }

  const offRequest = bridge.onRequest((request) => {
    if (request.type === 'start') void start(request)
    else if (request.type === 'stop') void stop(request)
    else void cancel(request)
  })

  return () => {
    startSequence += 1
    offRequest()
    if (active)
      void release(active, true).catch((error) => console.error('Microphone cleanup failed', error))
  }
}
