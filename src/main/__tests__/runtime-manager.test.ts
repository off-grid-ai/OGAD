import { describe, it, expect, vi } from 'vitest'
import {
  warmActionForMode,
  registerRuntime,
  unloadRuntime,
  registeredModalities,
  type ManagedRuntime
} from '../runtime-manager'
import { ModalityQueue } from '../modality-queue/queue'
import type { Modality, ResidencyMode } from '../runtime-residency'

describe('warmActionForMode', () => {
  it('resident re-warms (reload), on-demand releases (stay down, lazy load)', () => {
    expect(warmActionForMode('resident')).toBe('warm')
    expect(warmActionForMode('on-demand')).toBe('release')
  })
})

// A real, minimal runtime that records the order of lifecycle calls. Not a mock of
// our logic — it's a stand-in engine; the REAL ModalityQueue drives it end to end.
function recordingRuntime(modality: Modality, log: string[]): ManagedRuntime {
  return {
    modality,
    evict: () => {
      log.push('evict')
    },
    warm: () => {
      log.push('warm')
    },
    release: () => {
      log.push('release')
    }
  }
}

describe('registerRuntime (single mode-aware seam, real queue)', () => {
  it('resident: evict before the displacing job, warm (reload) after', async () => {
    const q = new ModalityQueue()
    const log: string[] = []
    registerRuntime(recordingRuntime('llm', log), { queue: q, readMode: () => 'resident' })

    await q.run({ tier: 2, label: 'image', evicts: ['llm'] }, async () => {
      log.push('job')
    })

    expect(log).toEqual(['evict', 'job', 'warm'])
  })

  it('on-demand: same evict/job order, but release (no reload) after', async () => {
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
        warm: () => {
          log.push('image-warm')
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

  it('clears the failed engine pause without warming it', async () => {
    const q = new ModalityQueue()
    let paused = false
    const warm = vi.fn()
    registerRuntime(
      {
        modality: 'llm',
        evict: () => {
          paused = true
          throw new Error('chat port still occupied')
        },
        warm,
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
    expect(warm).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('every modality flows through the SAME seam — mode alone changes behavior', async () => {
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
      expect(log).toEqual(['evict', 'job', modes[modality] === 'resident' ? 'warm' : 'release'])
    }
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
