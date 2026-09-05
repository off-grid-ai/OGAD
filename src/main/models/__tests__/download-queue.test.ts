import { describe, expect, it } from 'vitest'
import { DOWNLOAD_INTERRUPTED_ERROR, ModelDownloadQueue } from '@offgrid/models'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (e: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('ModelDownloadQueue', () => {
  it('caps transfers, reports counts, and drains waiting work FIFO', async () => {
    const queue = new ModelDownloadQueue(2)
    const boundaries = [deferred<void>(), deferred<void>(), deferred<void>()]
    const started: string[] = []
    const states: Record<string, string[]> = { a: [], b: [], c: [] }
    const jobs = ['a', 'b', 'c'].map((id, index) =>
      queue.enqueue(
        id,
        async () => {
          started.push(id)
          await boundaries[index]!.promise
          return { outcome: { kind: 'installed' } }
        },
        (state) => states[id]!.push(state)
      )
    )

    expect(started).toEqual(['a', 'b'])
    expect(queue.counts()).toEqual({ running: 2, queued: 1 })
    expect(states.c).toEqual(['queued'])

    boundaries[0]!.resolve()
    await jobs[0]
    expect(started).toEqual(['a', 'b', 'c'])
    expect(states.c).toEqual(['queued', 'downloading'])
    expect(queue.counts()).toEqual({ running: 2, queued: 0 })

    boundaries[1]!.resolve()
    boundaries[2]!.resolve()
    await Promise.all(jobs)
    expect(queue.counts()).toEqual({ running: 0, queued: 0 })
  })

  it('cancels waiting work without starting it and rejects duplicate keys', async () => {
    const queue = new ModelDownloadQueue(1)
    const active = deferred<void>()
    let queuedStarted = false
    const first = queue.enqueue(
      'active',
      async () => {
        await active.promise
        return { outcome: { kind: 'installed' } }
      },
      () => {}
    )
    const states: string[] = []
    const waiting = queue.enqueue(
      'waiting',
      async () => {
        queuedStarted = true
        return { outcome: { kind: 'installed' } }
      },
      (state) => states.push(state)
    )

    await expect(
      queue.enqueue(
        'waiting',
        async () => ({ outcome: { kind: 'installed' } }),
        () => {}
      )
    ).resolves.toEqual({
      outcome: { kind: 'failed', reason: 'already downloading' }
    })
    expect(queue.cancel('waiting')).toBe(true)
    await expect(waiting).resolves.toEqual({ outcome: { kind: 'cancelled' } })
    expect(states).toEqual(['queued', 'cancelled'])
    expect(queuedStarted).toBe(false)

    active.resolve()
    await first
  })

  it('releases an active slot when work rejects', async () => {
    const queue = new ModelDownloadQueue(1)
    const started: string[] = []
    const first = queue.enqueue(
      'first',
      async () => {
        started.push('first')
        throw new Error('network down')
      },
      () => {}
    )
    const second = queue.enqueue(
      'second',
      async () => {
        started.push('second')
        return { outcome: { kind: 'installed' } }
      },
      () => {}
    )

    await expect(first).resolves.toEqual({ outcome: { kind: 'failed', reason: 'network down' } })
    await expect(second).resolves.toEqual({ outcome: { kind: 'installed' } })
    expect(started).toEqual(['first', 'second'])
  })

  it('interrupts active and queued transfers and permanently closes admission on shutdown', async () => {
    const queue = new ModelDownloadQueue(1)
    const states: string[] = []
    const active = queue.enqueue(
      'active',
      (signal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => resolve({ outcome: { kind: 'aborted', reason: String(signal.reason) } }),
            { once: true }
          )
        }),
      () => {}
    )
    const queued = queue.enqueue(
      'queued',
      async () => ({ outcome: { kind: 'installed' } }),
      (state) => states.push(state)
    )

    const shutdown = queue.shutdown()
    await expect(queued).resolves.toEqual({
      outcome: { kind: 'interrupted', reason: DOWNLOAD_INTERRUPTED_ERROR }
    })
    await expect(active).resolves.toEqual({
      outcome: { kind: 'interrupted', reason: DOWNLOAD_INTERRUPTED_ERROR }
    })
    await expect(shutdown).resolves.toBeUndefined()
    expect(states).toEqual(['queued', 'interrupted'])
    expect(queue.counts()).toEqual({ running: 0, queued: 0 })
    await expect(
      queue.enqueue(
        'late',
        async () => ({ outcome: { kind: 'installed' } }),
        () => {}
      )
    ).resolves.toEqual({ outcome: { kind: 'interrupted', reason: DOWNLOAD_INTERRUPTED_ERROR } })
  })
})
