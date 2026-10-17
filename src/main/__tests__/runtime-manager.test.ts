import { describe, it, expect, vi } from 'vitest'
import {
  registerRuntime,
  unloadRuntime,
  registeredModalities,
  liveMemory,
  type ManagedRuntime
} from '../runtime-manager'
import { ModalityQueue } from '../modality-queue/queue'
import type { Modality, ResidencyMode } from '../runtime-residency'

// A real, minimal runtime that records the order of lifecycle calls. Not a mock of
// our logic — it's a stand-in engine; the REAL ModalityQueue drives it end to end.
function recordingRuntime(modality: Modality, log: string[]): ManagedRuntime {
  return {
    modality,
    evict: () => {
      log.push('evict')
    },
    release: () => {
      log.push('release')
    }
  }
}

describe('registerRuntime (single seam, real queue)', () => {
  it('resident: evict before the displacing job, release (no reload) after', async () => {
    const q = new ModalityQueue()
    const log: string[] = []
    registerRuntime(recordingRuntime('llm', log), { queue: q, readMode: () => 'resident' })

    await q.run({ tier: 2, label: 'image', evicts: ['llm'] }, async () => {
      log.push('job')
    })

    expect(log).toEqual(['evict', 'job', 'release'])
  })

  it('on-demand: the same evict, job, release order', async () => {
    const q = new ModalityQueue()
    const log: string[] = []
    registerRuntime(recordingRuntime('llm', log), { queue: q, readMode: () => 'on-demand' })

    await q.run({ tier: 2, label: 'image', evicts: ['llm'] }, async () => {
      log.push('job')
    })

    expect(log).toEqual(['evict', 'job', 'release'])
  })

  it('releases prior eviction blocks when a later eviction fails', async () => {
    const q = new ModalityQueue()
    const log: string[] = []
    registerRuntime(recordingRuntime('llm', log), { queue: q, readMode: () => 'resident' })
    registerRuntime(
      {
        modality: 'image',
        evict: () => {
          log.push('image-evict-failed')
          throw new Error('image server still running')
        },
        release: () => {
          log.push('image-release')
        }
      },
      { queue: q, readMode: () => 'resident' }
    )

    await expect(
      q.run({ tier: 2, label: 'video', evicts: ['llm', 'image'] }, async () => {
        log.push('video-started')
      })
    ).rejects.toThrow('image server still running')
    expect(log).toEqual(['evict', 'image-evict-failed', 'image-release', 'release'])
    expect(q.getState().running).toHaveLength(0)
  })

  it('clears the failed engine pause without loading it', async () => {
    const q = new ModalityQueue()
    let paused = false
    registerRuntime(
      {
        modality: 'llm',
        evict: () => {
          paused = true
          throw new Error('chat port still occupied')
        },
        release: () => {
          paused = false
        }
      },
      { queue: q, readMode: () => 'resident' }
    )

    const run = vi.fn(async () => {})
    await expect(q.run({ tier: 2, label: 'image', evicts: ['llm'] }, run)).rejects.toThrow(
      'chat port still occupied'
    )
    expect(paused).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('every modality flows through the SAME seam and is never reloaded after a job', async () => {
    // The point of the abstraction: the wiring is identical per engine; only the
    // persisted mode differs. Same registration path, same queue, uniform result.
    const modes: Record<Modality, ResidencyMode> = {
      llm: 'resident',
      image: 'resident',
      stt: 'on-demand',
      tts: 'on-demand',
      grounding: 'resident',
      decision: 'on-demand',
      embeddings: 'resident'
    }
    for (const modality of Object.keys(modes) as Modality[]) {
      const q = new ModalityQueue()
      const log: string[] = []
      registerRuntime(recordingRuntime(modality, log), { queue: q, readMode: (m) => modes[m] })
      await q.run({ tier: 2, label: 'x', evicts: [modality] }, async () => {
        log.push('job')
      })
      expect(log).toEqual(['evict', 'job', 'release'])
    }
  })
})

describe('residents stay loaded while they fit', () => {
  const imageJob = {
    tier: 2 as const,
    label: 'image',
    evicts: ['llm'],
    uses: { id: 'image', expectedMB: 2_000 }
  }
  const sized = (log: string[]): ManagedRuntime => ({
    ...recordingRuntime('llm', log),
    footprintMB: () => 4_000,
    expectedMB: () => 4_000
  })

  it('keeps a resident chat model through an image job when memory allows', async () => {
    const q = new ModalityQueue()
    q.setMemoryProbe(() => ({ availableMB: 48_000, totalMB: 64_000 }))
    const log: string[] = []
    registerRuntime(sized(log), { queue: q, readMode: () => 'resident' })
    await q.run(imageJob, async () => void log.push('job'))
    expect(log).not.toContain('evict')
    expect(log).toContain('job')
  })

  it('evicts it when the image model would not fit beside it', async () => {
    const q = new ModalityQueue()
    q.setMemoryProbe(() => ({ availableMB: 1_000, totalMB: 16_000 }))
    const log: string[] = []
    registerRuntime(sized(log), { queue: q, readMode: () => 'resident' })
    await q.run(imageJob, async () => void log.push('job'))
    expect(log.slice(0, 2)).toEqual(['evict', 'job'])
  })

  // As mobile counts it: what an engine holds now, whatever its mode. An on-demand engine can stay
  // loaded after its job (Whisper keeps its server for five minutes), so it counts while loaded.
  it('a loaded on-demand engine counts, and is freed when the job needs its memory', async () => {
    const q = new ModalityQueue()
    q.setMemoryProbe(() => ({ availableMB: 1_000, totalMB: 16_000 }))
    const log: string[] = []
    registerRuntime(sized(log), { queue: q, readMode: () => 'on-demand' })
    await q.run(imageJob, async () => void log.push('job'))
    expect(log.slice(0, 2)).toEqual(['evict', 'job'])
  })

  it('an on-demand engine that is down takes no room', async () => {
    const q = new ModalityQueue()
    q.setMemoryProbe(() => ({ availableMB: 1_000, totalMB: 16_000 }))
    const log: string[] = []
    registerRuntime(
      { ...sized(log), footprintMB: () => 0 },
      { queue: q, readMode: () => 'on-demand' }
    )
    await q.run(imageJob, async () => void log.push('job'))
    expect(log).not.toContain('evict')
  })

  /** A stand-in engine of `modality` holding `heldMB` now. */
  const holding = (modality: Modality, heldMB: number, log: string[]): ManagedRuntime => ({
    modality,
    evict: () => void log.push(`evict ${modality}`),
    release: () => undefined,
    footprintMB: () => heldMB,
    expectedMB: () => heldMB
  })

  // As mobile plans it: any idle engine may be freed, sidecars first, not only the one a job names.
  it('frees an idle transcription engine the job did not name, and keeps the chat model', async () => {
    const q = new ModalityQueue()
    // 4.2 GB free beside 5.5 GB held, less 3 GB headroom: the 2 GB image model fits once the
    // 1.5 GB transcription engine goes; the chat model can stay.
    q.setMemoryProbe(() => ({ availableMB: 4_200, totalMB: 16_000 }))
    const log: string[] = []
    registerRuntime(holding('llm', 4_000, log), { queue: q, readMode: () => 'resident' })
    registerRuntime(holding('stt', 1_500, log), { queue: q, readMode: () => 'on-demand' })
    await q.run(imageJob, async () => void log.push('job'))
    expect(log).toEqual(['evict stt', 'job'])
  })

  it('never frees an engine a running job is using', async () => {
    const q = new ModalityQueue()
    // 2 GB free beside 7 GB held: dictation's 1.5 GB fits once one model goes. The image model is
    // the lower-priority one, but an image job is using it, so the idle chat model goes instead.
    q.setMemoryProbe(() => ({ availableMB: 2_000, totalMB: 16_000 }))
    const log: string[] = []
    registerRuntime(holding('llm', 4_000, log), { queue: q, readMode: () => 'resident' })
    registerRuntime(holding('image', 3_000, log), { queue: q, readMode: () => 'resident' })
    let finishImage = (): void => undefined
    const imageRunning = q.run(
      { tier: 2, label: 'image', uses: { id: 'image', expectedMB: 3_000 } },
      () => new Promise<void>((resolve) => (finishImage = resolve))
    )
    await vi.waitFor(() => expect(q.getState().running).toHaveLength(1))
    await q.run(
      { tier: 1, label: 'dictation', uses: { id: 'stt', expectedMB: 1_500 } },
      async () => void log.push('dictation')
    )
    finishImage()
    await imageRunning
    expect(log).toEqual(['evict llm', 'dictation'])
  })

  it('reads live memory as available within total', () => {
    const { availableMB, totalMB } = liveMemory()
    expect(totalMB).toBeGreaterThan(0)
    expect(availableMB).toBeGreaterThan(0)
    expect(availableMB).toBeLessThanOrEqual(totalMB)
  })
})

describe('unloadRuntime (free one modality now — the Unload button)', () => {
  it('evicts the registered runtime, returns true, and is idempotent', async () => {
    const log: string[] = []
    registerRuntime(recordingRuntime('tts', log), {
      queue: new ModalityQueue(),
      readMode: () => 'on-demand'
    })
    expect(await unloadRuntime('tts')).toBe(true)
    expect(log).toEqual(['evict'])
    // Safe to call again when already down (evict is idempotent).
    expect(await unloadRuntime('tts')).toBe(true)
    expect(log).toEqual(['evict', 'evict'])
    expect(registeredModalities()).toContain('tts')
  })

  it('returns false when no runtime is registered for that modality', async () => {
    // A modality with nothing registered (bogus id is deterministic vs the shared
    // module registry other tests populate).
    expect(await unloadRuntime('nonexistent' as unknown as Modality)).toBe(false)
  })
})
