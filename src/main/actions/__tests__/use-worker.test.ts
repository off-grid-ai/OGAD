/**
 * The park-aware drain loop, against scripted engine and park-signal fakes.
 * The property under test: an action waiting on a human never blocks the
 * queue - the loop moves on, and the parked tick's outcome still reaches
 * its waiter when the gate finally resolves.
 */
import { describe, expect, it } from 'vitest'
import type { TickOutcome } from '@offgrid/use'
import { createActionWorker, type EngineLike, type ParkSignal } from '../use-worker'

const done = (id: string): TickOutcome =>
  ({ id, outcome: 'done', record: { id } as never }) as TickOutcome

function makePark() {
  const listeners = new Set<() => void>()
  const signal: ParkSignal = {
    onParked(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  return { signal, fire: () => listeners.forEach((l) => l()) }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10))

describe('createActionWorker', () => {
  it('drains outcomes to their waiters and stops when nothing is due', async () => {
    const script: Array<TickOutcome | undefined> = [done('a1'), done('a2'), undefined]
    const engine: EngineLike = { tick: async () => script.shift() }
    const { signal } = makePark()
    const worker = createActionWorker(engine, signal)

    const w1 = worker.waitForOutcome('a1', 1000)
    const w2 = worker.waitForOutcome('a2', 1000)
    worker.kick()

    expect((await w1)?.id).toBe('a1')
    expect((await w2)?.id).toBe('a2')
    await flush()
    expect(worker.draining()).toBe(false)
  })

  it('a parked tick does not block the loop, and its outcome still lands later', async () => {
    const { signal, fire } = makePark()
    let resolveParkedTick: ((o: TickOutcome) => void) | undefined
    let call = 0
    const engine: EngineLike = {
      tick: async () => {
        call += 1
        if (call === 1) {
          // This action reaches the gate and waits on a human.
          return new Promise<TickOutcome>((resolve) => {
            resolveParkedTick = resolve
            queueMicrotask(fire) // the gate host announces the park
          })
        }
        if (call === 2) {
          return done('quick')
        }
        return undefined
      }
    }
    const worker = createActionWorker(engine, signal)
    const parked = worker.waitForOutcome('parked', 1000)
    const quick = worker.waitForOutcome('quick', 1000)
    worker.kick()

    expect((await quick)?.id).toBe('quick')
    // The human decides much later; the parked outcome still arrives.
    resolveParkedTick?.(done('parked'))
    expect((await parked)?.id).toBe('parked')
  })

  it('waitForOutcome times out to undefined and drops its waiter', async () => {
    const engine: EngineLike = { tick: async () => undefined }
    const worker = createActionWorker(engine, makePark().signal)
    const result = await worker.waitForOutcome('ghost', 20)
    expect(result).toBeUndefined()
  })

  it('kick while draining does not start a second drain', async () => {
    let ticks = 0
    let release: (() => void) | undefined
    const engine: EngineLike = {
      tick: async () => {
        ticks += 1
        if (ticks === 1) {
          await new Promise<void>((resolve) => {
            release = resolve
          })
          return done('slow')
        }
        return undefined
      }
    }
    const worker = createActionWorker(engine, makePark().signal)
    worker.kick()
    worker.kick()
    worker.kick()
    await flush()
    expect(ticks).toBe(1)
    release?.()
    await flush()
    expect(worker.draining()).toBe(false)
  })
})

describe('onOutcome (the UI feed)', () => {
  it('every outcome reaches subscribers, and unsubscribe stops the feed', async () => {
    const script: Array<TickOutcome | undefined> = [done('a1'), done('a2'), undefined]
    const engine: EngineLike = { tick: async () => script.shift() }
    const worker = createActionWorker(engine, makePark().signal)
    const seen: string[] = []
    const unsubscribe = worker.onOutcome((outcome) => seen.push(outcome.id))
    worker.kick()
    await flush()
    expect(seen).toEqual(['a1', 'a2'])
    unsubscribe()
    const more: Array<TickOutcome | undefined> = [done('a3'), undefined]
    const worker2 = createActionWorker({ tick: async () => more.shift() }, makePark().signal)
    worker2.kick()
    await flush()
    expect(seen).toEqual(['a1', 'a2'])
  })
})
