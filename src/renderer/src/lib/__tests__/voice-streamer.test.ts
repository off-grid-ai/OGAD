/**
 * The renderer no longer owns a speech queue, sentence segmenter, or voice streamer. This suite
 * preserves their user-observable contract through the public application facade. Only model
 * inventory, audio synthesis, playback, and time are device boundaries.
 */
import {
  createOffGridApplication,
  type ModelsPlatformPorts,
  type OffGridApplication,
  type SpeechEvent,
  type SpeechPlatformPorts
} from '@offgrid/application'
import { afterEach, describe, expect, it } from 'vitest'

type SynthesizedAudio = Awaited<ReturnType<SpeechPlatformPorts['synthesizer']['synthesize']>>

interface SpeechHarness {
  application: OffGridApplication
  events: SpeechEvent[]
  played: string[]
}

const applications: OffGridApplication[] = []

function modelsBoundary(): ModelsPlatformPorts {
  const selections = new Map<string, string | null>()
  return {
    selection: {
      read: (modality) => selections.get(modality) ?? null,
      write: (modality, routeId) => {
        selections.set(modality, routeId)
      }
    },
    memory: {
      current: () => ({ totalMB: 16_000, availableMB: 8_000, platform: 'desktop' })
    },
    remote: {
      configuration: {
        read: () => ({ version: 1, activeServerId: null, servers: [] }),
        write: async () => undefined
      },
      credentials: {
        read: async () => null,
        write: async () => undefined,
        remove: async () => undefined
      },
      providers: {
        register: async () => undefined,
        unregister: async () => undefined
      }
    }
  }
}

function inlineText(audio: SynthesizedAudio): string {
  if (audio.kind !== 'inline') throw new Error(`Expected inline audio, received ${audio.kind}.`)
  return audio.dataUri.replace('speech:', '')
}

async function createSpeechHarness(
  overrides: Partial<Pick<SpeechPlatformPorts, 'cleanForSpeech' | 'synthesizer' | 'playback'>> = {}
): Promise<SpeechHarness> {
  const played: string[] = []
  const base: SpeechPlatformPorts = {
    microphone: {
      start: async () => undefined,
      stop: async () => ({ bytes: new Uint8Array(), mime: 'audio/wav' }),
      cancel: () => undefined,
      onLevel: () => () => undefined,
      echoCancelled: () => true
    },
    transcriber: {
      ready: () => false,
      transcribe: async () => ({ text: '' })
    },
    synthesizer: {
      ready: () => true,
      synthesize: async ({ text }) => ({ kind: 'inline', dataUri: `speech:${text}` })
    },
    playback: {
      play: async (audio) => {
        played.push(inlineText(audio))
      },
      stop: () => undefined
    },
    files: { remove: async () => undefined },
    clock: {
      now: () => Date.now(),
      after: (ms, run) => {
        const timer = setTimeout(run, ms)
        return () => clearTimeout(timer)
      }
    },
    cleanTranscript: (text) => text,
    cleanForSpeech: (text) => text.replace(/\*\*/g, ''),
    selection: {
      read: async () => ({ stt: null, tts: 'orpheus', voice: 'tara' }),
      write: async () => undefined
    }
  }
  const application = createOffGridApplication({
    models: modelsBoundary(),
    speech: { ...base, ...overrides }
  })
  applications.push(application)
  const events: SpeechEvent[] = []
  application.speech.events((event) => events.push(event))
  await application.start()
  return { application, events, played }
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('Speech did not reach the expected state.')
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.stop()))
})

describe('Desktop streaming speech through the application facade', () => {
  it('speaks complete sentences in order while it holds the trailing partial', async () => {
    const { application, played } = await createSpeechHarness()

    application.speech.feedStream({
      operationId: 'turn-1',
      delta: 'Hello there, this is fine. And the sec'
    })
    await until(() => played.length === 1)
    expect(played).toEqual(['Hello there, this is fine.'])

    application.speech.feedStream({ operationId: 'turn-1', delta: 'ond one is here too. ' })
    await until(() => played.length === 2)
    expect(played).toEqual(['Hello there, this is fine.', 'And the second one is here too.'])
  })

  it('reassembles a sentence streamed one character at a time', async () => {
    const { application, played } = await createSpeechHarness()

    for (const delta of 'The quick brown fox jumps. ') {
      application.speech.feedStream({ operationId: 'turn-2', delta })
    }

    await until(() => played.length === 1)
    expect(played).toEqual(['The quick brown fox jumps.'])
  })

  it('uses newlines as boundaries and never speaks blank input', async () => {
    const { application, played } = await createSpeechHarness()

    application.speech.feedStream({
      operationId: 'turn-3',
      delta: 'First line here\nSecond line here\n   \n'
    })
    application.speech.finishStream('turn-3')

    await until(() => played.length === 2)
    expect(played).toEqual(['First line here', 'Second line here'])
  })

  it('merges a short fragment into the next complete sentence', async () => {
    const { application, played } = await createSpeechHarness()

    application.speech.feedStream({ operationId: 'turn-4', delta: 'Ok. ' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(played).toEqual([])
    application.speech.feedStream({
      operationId: 'turn-4',
      delta: 'Now here is a real sentence. '
    })

    await until(() => played.length === 1)
    expect(played).toEqual(['Ok. Now here is a real sentence.'])
  })

  it('splits a long run at a word boundary before the turn finishes', async () => {
    const { application, played } = await createSpeechHarness()

    application.speech.feedStream({ operationId: 'turn-5', delta: 'word '.repeat(60) })

    await until(() => played.length > 0)
    expect(played[0]?.endsWith('word')).toBe(true)
    expect(played[0]).not.toContain('  ')
  })

  it('speaks the trailing partial only when the turn finishes', async () => {
    const { application, played } = await createSpeechHarness()

    application.speech.feedStream({
      operationId: 'turn-6',
      delta: 'a closing thought with no period'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(played).toEqual([])

    application.speech.finishStream('turn-6')
    await until(() => played.length === 1)
    expect(played).toEqual(['a closing thought with no period'])
  })

  it('cleans each segment before synthesis and playback', async () => {
    const { application, played } = await createSpeechHarness()

    application.speech.feedStream({
      operationId: 'turn-7',
      delta: 'This is the **first** sentence. '
    })

    await until(() => played.length === 1)
    expect(played).toEqual(['This is the first sentence.'])
  })

  it('does not start the next playback before the current playback finishes', async () => {
    const events: string[] = []
    let releaseFirst!: () => void
    const { application } = await createSpeechHarness({
      playback: {
        play: async (audio) => {
          const text = inlineText(audio)
          events.push(`start:${text}`)
          if (text === 'Sentence one is ready.') {
            await new Promise<void>((resolve) => {
              releaseFirst = resolve
            })
          }
          events.push(`end:${text}`)
        },
        stop: () => undefined
      }
    })

    application.speech.feedStream({
      operationId: 'turn-8',
      delta: 'Sentence one is ready. Sentence two is ready. '
    })
    await until(() => events.length === 1)
    expect(events).toEqual(['start:Sentence one is ready.'])

    releaseFirst()
    await until(() => events.length === 4)
    expect(events).toEqual([
      'start:Sentence one is ready.',
      'end:Sentence one is ready.',
      'start:Sentence two is ready.',
      'end:Sentence two is ready.'
    ])
  })

  it('interrupts active playback and clears all pending sentences', async () => {
    const started: string[] = []
    const { application } = await createSpeechHarness({
      playback: {
        play: async (audio, signal) => {
          started.push(inlineText(audio))
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
        },
        stop: () => undefined
      }
    })

    application.speech.feedStream({
      operationId: 'turn-9',
      delta:
        'This is the first full sentence. This is the second full sentence. This is the third full sentence. '
    })
    await until(() => started.length === 1)

    await application.speech.interrupt()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(started).toEqual(['This is the first full sentence.'])
    expect(application.speech.snapshot().playback.status).toBe('interrupted')
  })

  it('starts a new turn only after it interrupts the previous turn', async () => {
    const started: string[] = []
    const { application } = await createSpeechHarness({
      playback: {
        play: async (audio, signal) => {
          const text = inlineText(audio)
          started.push(text)
          if (text.startsWith('Old')) {
            await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
          }
        },
        stop: () => undefined
      }
    })

    application.speech.feedStream({
      operationId: 'old-turn',
      delta: 'Old turn one. Old turn two. '
    })
    await until(() => started.length === 1)
    application.speech.feedStream({ operationId: 'new-turn', delta: 'New turn is ready. ' })

    await until(() => started.includes('New turn is ready.'))
    expect(started).toEqual(['Old turn one.', 'New turn is ready.'])
  })

  it('reports the completed operation through the retained projection and event stream', async () => {
    const { application, events } = await createSpeechHarness()

    application.speech.feedStream({ operationId: 'turn-10', delta: 'The answer is ready. ' })
    application.speech.finishStream('turn-10')
    await until(() =>
      events.some((event) => event.type === 'speech_finished' && event.operationId === 'turn-10')
    )

    expect(application.speech.snapshot().playback.outcome).toEqual({ kind: 'spoken' })
    expect(application.speech.snapshot().playbackOperations.recent).toContainEqual({
      operationId: 'turn-10',
      status: 'finished',
      outcome: { kind: 'spoken' }
    })
  })

  it('continues after one failed segment but retains and emits the failure', async () => {
    const { application, events, played } = await createSpeechHarness({
      synthesizer: {
        ready: () => true,
        synthesize: async ({ text }) => {
          if (text.includes('bad')) throw new Error('synth down')
          return { kind: 'inline', dataUri: `speech:${text}` }
        }
      }
    })

    application.speech.feedStream({
      operationId: 'turn-11',
      delta: 'Good one here. This is bad now. Good three here. '
    })
    application.speech.finishStream('turn-11')
    await until(() =>
      events.some((event) => event.type === 'speech_finished' && event.operationId === 'turn-11')
    )

    expect(played).toEqual(['Good one here.', 'Good three here.'])
    expect(events).toContainEqual({
      type: 'speech_segment_failed',
      failed: true,
      operationId: 'turn-11',
      text: 'This is bad now.',
      outcome: { kind: 'synthesis-failed', detail: 'synth down' }
    })
    expect(application.speech.snapshot().playback.outcome).toEqual({
      kind: 'synthesis-failed',
      detail: 'synth down'
    })
    expect(application.speech.snapshot().playbackOperations.recent).toContainEqual({
      operationId: 'turn-11',
      status: 'finished',
      outcome: { kind: 'synthesis-failed', detail: 'synth down' }
    })
  })
})
