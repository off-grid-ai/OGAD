import {
  EMPTY_LIVE_TRANSCRIPT,
  LIVE_INTERIM_EVERY_MS,
  LIVE_SEGMENT_LOOKBACK_MS,
  LiveSegmenter,
  SpeechEndpointTimer,
  floatPcmWav,
  liveTranscriptText,
  settleAll,
  withFinal,
  withInterim,
  type LiveTranscript
} from '@offgrid/speech'

/*
 * Live transcription for a chat voice turn: the microphone port.
 *
 * Taps the same stream the recorder uses, cuts it into segments at pauses (@offgrid/speech decides
 * where), and runs the local speech engine on each one: a guess every second for the segment still
 * being spoken, and a final pass once it ends. What is shown and what is sent both come from the one
 * transcript in @offgrid/speech, so nothing heard on screen can go missing from the message.
 */

/** Whisper's native rate. Capturing at it means no resampling anywhere. */
const SAMPLE_RATE = 16_000
const BUFFER_SIZE = 2048
const PUMP_EVERY_MS = 250

export type LiveTranscribe = (wav: Uint8Array, requestId: string) => Promise<string>

interface Job {
  id: number
  final: boolean
  samples: Float32Array
}

function join(chunks: readonly Float32Array[]): Float32Array {
  let length = 0
  for (const chunk of chunks) length += chunk.length
  const out = new Float32Array(length)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (const sample of samples) sum += sample * sample
  return Math.sqrt(sum / samples.length)
}

export class ChatLiveTranscriber {
  private transcript: LiveTranscript = EMPTY_LIVE_TRANSCRIPT
  private context: AudioContext | null = null
  private processor: ScriptProcessorNode | null = null
  private pump: ReturnType<typeof setInterval> | null = null
  private readonly segmenter = new LiveSegmenter()
  /** Judges speech by the one noise-floor rule; never begun, so it never ends a turn itself. */
  private readonly speech = new SpeechEndpointTimer(() => undefined)
  private segmentId = 0
  private chunks: Float32Array[] = []
  private lastInterimAt = 0
  private lastInterimLength = 0
  private readonly finals: Job[] = []
  private inFlight: string | null = null
  private stopped = false
  private drained: (() => void) | null = null

  constructor(
    private readonly transcribe: LiveTranscribe,
    private readonly cancelRequest: (requestId: string) => void,
    private readonly onChange: (transcript: LiveTranscript) => void
  ) {}

  /** Starts listening to the stream. False when this machine cannot tap it; the turn then records
   *  as before and is transcribed once it ends. */
  start(stream: MediaStream): boolean {
    try {
      const context = new window.AudioContext({ sampleRate: SAMPLE_RATE })
      const source = context.createMediaStreamSource(stream)
      const processor = context.createScriptProcessor(BUFFER_SIZE, 1, 1)
      const mute = context.createGain()
      mute.gain.value = 0
      processor.onaudioprocess = (event) => this.hear(event.inputBuffer.getChannelData(0))
      source.connect(processor)
      // A processor only runs while connected to the output; the gain keeps it silent.
      processor.connect(mute)
      mute.connect(context.destination)
      this.context = context
      this.processor = processor
      this.segmenter.begin(Date.now())
      this.pump = setInterval(() => this.next(), PUMP_EVERY_MS)
      return true
    } catch {
      this.release()
      return false
    }
  }

  current(): LiveTranscript {
    return this.transcript
  }

  /** Stops listening, settles every segment, and returns everything said. */
  async finish(): Promise<string> {
    if (this.stopped) return liveTranscriptText(this.transcript)
    this.release()
    this.commit()
    if (this.inFlight || this.finals.length > 0) {
      await new Promise<void>((resolve) => {
        this.drained = resolve
        this.next()
      })
    }
    this.stopped = true
    this.update(settleAll(this.transcript))
    return liveTranscriptText(this.transcript)
  }

  /** Throws the turn away: no more passes, and the one running is cancelled. */
  cancel(): void {
    this.stopped = true
    this.release()
    this.finals.length = 0
    if (this.inFlight) this.cancelRequest(this.inFlight)
    this.inFlight = null
    this.drained?.()
    this.drained = null
  }

  private release(): void {
    if (this.pump) clearInterval(this.pump)
    this.pump = null
    if (this.processor) {
      this.processor.onaudioprocess = null
      this.processor.disconnect()
    }
    this.processor = null
    if (this.context) void this.context.close().catch(() => {})
    this.context = null
  }

  private hear(input: Float32Array): void {
    if (this.stopped) return
    const samples = new Float32Array(input)
    const now = Date.now()
    const action = this.segmenter.observe(this.speech.observeLevel(rms(samples), now).speech, now)
    this.chunks.push(samples)
    if (action === 'trim') {
      // Nothing said yet: keep only the lookback, so the first syllable survives.
      const keep = Math.ceil((SAMPLE_RATE * LIVE_SEGMENT_LOOKBACK_MS) / 1000 / BUFFER_SIZE)
      if (this.chunks.length > keep) this.chunks = this.chunks.slice(-keep)
    } else if (action === 'commit') {
      this.commit()
      this.next()
    }
  }

  /** Ends the open segment. A segment nobody spoke in is never decoded. */
  private commit(): void {
    if (this.segmenter.hasSpeech() && this.chunks.length > 0) {
      this.finals.push({ id: this.segmentId, final: true, samples: join(this.chunks) })
      this.segmentId += 1
    }
    this.chunks = []
    this.lastInterimLength = 0
    this.segmenter.begin(Date.now())
  }

  /** Runs one pass at a time: settled segments first, then a fresh guess for the open one. */
  private next(): void {
    if (this.inFlight) return
    const job = this.finals.shift() ?? this.interimJob()
    if (!job) {
      if (this.finals.length === 0 && this.drained) {
        this.drained()
        this.drained = null
      }
      return
    }
    void this.run(job)
  }

  private interimJob(): Job | null {
    if (this.stopped || !this.processor || !this.segmenter.hasSpeech()) return null
    const now = Date.now()
    if (now - this.lastInterimAt < LIVE_INTERIM_EVERY_MS) return null
    if (this.chunks.length === this.lastInterimLength) return null
    this.lastInterimAt = now
    this.lastInterimLength = this.chunks.length
    return { id: this.segmentId, final: false, samples: join(this.chunks) }
  }

  private async run(job: Job): Promise<void> {
    const requestId = crypto.randomUUID()
    this.inFlight = requestId
    let text = ''
    try {
      text = await this.transcribe(floatPcmWav(job.samples, SAMPLE_RATE), requestId)
    } catch {
      // A guess that fails changes nothing; a final that fails keeps its last guess.
    }
    if (this.inFlight !== requestId) return
    this.inFlight = null
    this.update(
      job.final
        ? withFinal(this.transcript, job.id, text)
        : withInterim(this.transcript, job.id, text)
    )
    this.next()
  }

  private update(next: LiveTranscript): void {
    if (next === this.transcript) return
    this.transcript = next
    this.onChange(next)
  }
}
