import { describe, it, expect } from 'vitest'
import { ModalityQueue, type MemoryProbe, type QueueRequest } from '../modality-queue/queue'
import { registerRuntime, type ManagedRuntime } from '../runtime-manager'
import { normalizeResidency, type Modality, type ResidencyMode } from '../runtime-residency-logic'

// Integration test: the REAL ModalityQueue + REAL registerRuntime seam driving engine
// stand-ins at the native boundary (where a real engine spawns llama-server or sd-server).
// No mocks of our own logic — each engine tracks whether its model is loaded and how many
// times it loaded, so an assertion reflects the true effect of evict/release through the queue.

/** An engine at the native boundary: it loads lazily on use, like the real ones. */
class FakeEngine implements ManagedRuntime {
  loaded = false
  loads = 0
  private paused = false
  constructor(
    readonly modality: Modality,
    private readonly sizeMB = 4_000
  ) {}
  /** The engine's own run path: load on first use, unless a job evicted it and is still running. */
  use(): void {
    if (this.paused) throw new Error(`${this.modality} is paused`)
    if (!this.loaded) {
      this.loaded = true
      this.loads += 1
    }
  }
  evict(): void {
    this.loaded = false
    this.paused = true
  }
  release(): void {
    this.paused = false
  }
  footprintMB(): number {
    return this.loaded ? this.sizeMB : 0
  }
  expectedMB(): number {
    return this.sizeMB
  }
}

/** Residency map backed by a plain object, mutated like the real persisted store. */
interface MutableResidencyStore {
  read: (modality: Modality) => ResidencyMode
  set: (modality: Modality, mode: ResidencyMode) => void
}

function store(initial: Partial<Record<Modality, ResidencyMode>>): MutableResidencyStore {
  const map = normalizeResidency(initial)
  return {
    read: (m: Modality) => map[m],
    set: (m: Modality, mode: ResidencyMode) => {
      map[m] = mode
    }
  }
}

/** Live memory on a machine with `availableMB` free beside what the engines hold. */
const memory =
  (availableMB: number, totalMB = 32_768): MemoryProbe =>
  () => ({
    availableMB,
    totalMB
  })

const CHAT: QueueRequest = { tier: 2, label: 'chat', uses: { id: 'llm' }, evicts: ['image'] }
const IMAGE: QueueRequest = { tier: 2, label: 'image', uses: { id: 'image' }, evicts: ['llm'] }

/** The app's wiring: both engines registered through the one seam, memory read live. */
interface TestApp {
  q: ModalityQueue
  s: MutableResidencyStore
  llm: FakeEngine
  image: FakeEngine
}

function app(availableMB: number, modes: Partial<Record<Modality, ResidencyMode>> = {}): TestApp {
  const q = new ModalityQueue()
  const s = store({ image: 'resident', ...modes })
  const llm = new FakeEngine('llm', 5_000)
  const image = new FakeEngine('image', 4_500)
  registerRuntime(llm, { queue: q, readMode: s.read })
  registerRuntime(image, { queue: q, readMode: s.read })
  q.setMemoryProbe(memory(availableMB))
  return { q, s, llm, image }
}

describe('lazy residency (real queue + real seam)', () => {
  it('nothing loads at startup; a model loads on its first use only', async () => {
    const { q, llm, image } = app(20_000)
    expect([llm.loads, image.loads]).toEqual([0, 0])

    await q.run(CHAT, async () => llm.use())

    expect(llm.loaded).toBe(true)
    expect([llm.loads, image.loads]).toEqual([1, 0])
  })

  it('after an evicting job, the resident chat model is not reloaded until it is used', async () => {
    // 3 GB free beside the 5 GB chat model: the 4.5 GB image model does not fit with it.
    const { q, llm, image } = app(3_000)
    await q.run(CHAT, async () => llm.use())

    let chatDuringImage: boolean | null = null
    await q.run(IMAGE, async () => {
      chatDuringImage = llm.loaded
      image.use()
    })

    expect(chatDuringImage).toBe(false) // evicted to make room
    expect(llm.loaded).toBe(false) // and still down: nobody asked for it
    expect(llm.loads).toBe(1)

    await q.run(CHAT, async () => llm.use())
    expect(llm.loaded).toBe(true) // loads again on its next use
    expect(llm.loads).toBe(2)
  })

  it('two models stay side by side when live memory allows', async () => {
    const { q, llm, image } = app(20_000)
    await q.run(CHAT, async () => llm.use())
    await q.run(IMAGE, async () => image.use())
    await q.run(CHAT, async () => llm.use())

    expect([llm.loaded, image.loaded]).toEqual([true, true])
    expect([llm.loads, image.loads]).toEqual([1, 1]) // nothing evicted, nothing reloaded
  })

  it('an on-demand model never counts as resident, so it never displaces another', async () => {
    // Tight memory, but the image engine is on-demand: its memory is its own job's, freed after.
    const { q, llm, image } = app(3_000, { image: 'on-demand' })
    await q.run(IMAGE, async () => image.use())
    await q.run(CHAT, async () => llm.use())
    expect(image.loads).toBe(1)
    expect(llm.loaded).toBe(true)
  })
})

describe('residency integration (real queue + real seam + real engines)', () => {
  it('resident LLM: an image job evicts it, and it stays down until its next use', async () => {
    const q = new ModalityQueue()
    const s = store({ llm: 'resident' })
    const llm = new FakeEngine('llm')
    registerRuntime(llm, { queue: q, readMode: s.read })
    llm.use()

    let duringJob: boolean | null = null
    await q.run({ tier: 2, label: 'image', evicts: ['llm'] }, async () => {
      duringJob = llm.loaded // LLM must be evicted while the image job runs
    })

    expect(duringJob).toBe(false) // evicted before/for the job
    expect(llm.loaded).toBe(false) // not reloaded for nobody
    llm.use() // the pause block was cleared, so its next use loads it
    expect(llm.loaded).toBe(true)
  })

  it('on-demand engine: evicted for the job and left DOWN afterwards (RAM stays free)', async () => {
    // Use an UNLOCKED modality (tts) — the llm is locked resident (screen replay),
    // so it can never be on-demand; that lock is asserted in runtime-residency.test.
    const q = new ModalityQueue()
    const s = store({ tts: 'on-demand' })
    const tts = new FakeEngine('tts')
    registerRuntime(tts, { queue: q, readMode: s.read })
    tts.use()

    await q.run({ tier: 2, label: 'image', evicts: ['tts'] }, async () => {})
    expect(tts.loaded).toBe(false) // on-demand -> stays down (release, no reload)
  })

  it('an engine that lazily reloaded is STILL evicted next round (no double-resident)', async () => {
    // The correctness guarantee: the queue always evicts a declared id, so an
    // on-demand engine that reloaded itself between jobs cannot stay resident
    // alongside the next heavy model (the beachball this whole system prevents).
    const q = new ModalityQueue()
    const s = store({ tts: 'on-demand' })
    const tts = new FakeEngine('tts')
    registerRuntime(tts, { queue: q, readMode: s.read })
    tts.use()

    await q.run({ tier: 2, label: 'image', evicts: ['tts'] }, async () => {})
    expect(tts.loaded).toBe(false)
    tts.use() // the engine lazily reloads itself between jobs

    let duringJob: boolean | null = null
    await q.run({ tier: 2, label: 'image', evicts: ['tts'] }, async () => {
      duringJob = tts.loaded
    })
    expect(duringJob).toBe(false) // evicted again despite having reloaded
  })

  it('two heavy engines never run at once; the queued one waits', async () => {
    const q = new ModalityQueue()
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })

    const first = q.run({ tier: 2, label: 'image-a' }, async () => {
      order.push('a-start')
      await gate
      order.push('a-end')
    })
    const second = q.run({ tier: 2, label: 'image-b' }, async () => {
      order.push('b-start')
    })

    await new Promise((r) => setTimeout(r, 0))
    expect(order).toEqual(['a-start']) // b is waiting, not running
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['a-start', 'a-end', 'b-start']) // strictly sequential
  })
})
