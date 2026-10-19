// Branch fill for ModalityQueue. queue.test.ts covers ordering / eviction / coexist;
// this drives the error-and-edge paths: a declared-but-unregistered evictable is
// skipped, an evict failure rejects admission, a release failure is caught, an
// evictable with no release hook is skipped, and an onChange listener that throws
// is isolated. Real ModalityQueue, no mocks of its own logic.
import { describe, it, expect, vi } from 'vitest'
import { ModalityQueue } from '../queue'

describe('ModalityQueue error + edge branches', () => {
  it('skips an evicts id that was never registered (no throw)', async () => {
    const q = new ModalityQueue()
    let ran = false
    await q.run({ tier: 2, label: 'x', evicts: ['not-registered'] }, async () => {
      ran = true
    })
    expect(ran).toBe(true)
  })

  it('rejects a job if eviction fails and releases the queue slot', async () => {
    const q = new ModalityQueue()
    const evict = vi.fn(async () => {
      throw new Error('evict boom')
    })
    q.registerEvictable('llm', { evict })
    let ran = false
    await expect(
      q.run({ tier: 2, label: 'x', evicts: ['llm'] }, async () => {
        ran = true
      })
    ).rejects.toThrow('evict boom')
    expect(evict).toHaveBeenCalledTimes(1)
    expect(ran).toBe(false)
    expect(q.getState().running).toHaveLength(0)
    await expect(q.run({ tier: 2, label: 'next' }, async () => 7)).resolves.toBe(7)
  })

  it('finishes a job whose evictable has no release hook', async () => {
    const q = new ModalityQueue()
    const evict = vi.fn()
    q.registerEvictable('llm', { evict }) // no recover
    await expect(q.run({ tier: 2, label: 'x', evicts: ['llm'] }, async () => 7)).resolves.toBe(7)
    expect(evict).toHaveBeenCalledTimes(1)
  })

  it('catches a release that throws in the finally cleanup', async () => {
    const q = new ModalityQueue()
    const recover = vi.fn(async () => {
      throw new Error('release boom')
    })
    q.registerEvictable('llm', { evict: vi.fn(), recover })
    // The rejection from release must be swallowed - run() still resolves.
    await expect(q.run({ tier: 2, label: 'x', evicts: ['llm'] }, async () => 7)).resolves.toBe(7)
    expect(recover).toHaveBeenCalledTimes(1)
  })

  it('isolates an onChange listener that throws (scheduler survives)', async () => {
    const q = new ModalityQueue()
    const good = vi.fn()
    q.onChange(() => {
      throw new Error('listener boom')
    })
    q.onChange(good)
    await q.run({ tier: 2, label: 'x' }, async () => {})
    expect(good).toHaveBeenCalled() // the good listener still fired despite the bad one
  })

  it('onChange returns an unsubscribe that stops further notifications', async () => {
    const q = new ModalityQueue()
    const cb = vi.fn()
    const off = q.onChange(cb)
    off()
    await q.run({ tier: 2, label: 'x' }, async () => {})
    expect(cb).not.toHaveBeenCalled()
  })

  it('setEnabled toggles isEnabled', () => {
    const q = new ModalityQueue()
    expect(q.isEnabled()).toBe(true)
    q.setEnabled(false)
    expect(q.isEnabled()).toBe(false)
  })

  it('getState reflects a running job while it is in flight', async () => {
    const q = new ModalityQueue()
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const p = q.run({ tier: 2, label: 'inflight' }, async () => {
      await gate
    })
    // Let the microtask admit the job.
    await Promise.resolve()
    await Promise.resolve()
    expect(q.getState().running.map((r) => r.label)).toContain('inflight')
    release()
    await p
    expect(q.getState().running).toHaveLength(0)
  })
})
