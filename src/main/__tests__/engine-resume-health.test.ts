import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  return { powerMonitor: new Emitter() }
})

import {
  installEngineResumeHealth,
  registerResumeHealthTarget,
  waitForEngineResumeHealth
} from '../engine-resume-health'

/** An engine as the wake check sees it: whether it should run, whether it answers, its restarts. */
interface Engine {
  target: Parameters<typeof registerResumeHealthTarget>[0]
  restarts: number[]
  state: { running: boolean; healthy: boolean; restartFails?: boolean }
}

function engine(id: string, state: Engine['state']): Engine {
  const restarts: number[] = []
  const target = {
    id,
    shouldBeRunning: () => state.running,
    healthCheck: async () => {
      if (state.healthy === undefined) throw new Error('no answer')
      return state.healthy
    },
    restart: async () => {
      restarts.push(Date.now())
      if (state.restartFails) throw new Error(`${id} would not start`)
      state.healthy = true
    }
  }
  return { target, restarts, state }
}

let monitor: EventEmitter
let invalidations: number
let dispose: () => void
const unregister: Array<() => void> = []

beforeEach(() => {
  vi.useFakeTimers()
  monitor = new EventEmitter()
  invalidations = 0
  dispose = installEngineResumeHealth({
    // The wake events, as Electron's powerMonitor emits them.
    powerMonitor: monitor as unknown as NonNullable<
      Parameters<typeof installEngineResumeHealth>[0]
    >['powerMonitor'],
    invalidateBackendFacts: () => {
      invalidations++
    }
  })
})

afterEach(() => {
  dispose()
  for (const off of unregister.splice(0)) off()
  vi.useRealTimers()
})

describe('engine health after wake', () => {
  it('restarts only the engines that should run and stopped answering', async () => {
    const stalled = engine('chat', { running: true, healthy: false })
    const fine = engine('image', { running: true, healthy: true })
    const idle = engine('voice', { running: false, healthy: false })
    for (const { target } of [stalled, fine, idle])
      unregister.push(registerResumeHealthTarget(target))

    monitor.emit('resume')
    expect(invalidations).toBe(1)
    // Requests that arrive during the wake debounce wait for the check.
    let waited = false
    const waiting = waitForEngineResumeHealth().then(() => {
      waited = true
    })
    await vi.advanceTimersByTimeAsync(1_999)
    expect(stalled.restarts).toHaveLength(0)
    expect(waited).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await waiting
    expect(waited).toBe(true)
    expect(stalled.restarts).toHaveLength(1)
    expect(fine.restarts).toHaveLength(0)
    expect(idle.restarts).toHaveLength(0)
  })

  it('checks once for a burst of wake and unlock events', async () => {
    const stalled = engine('chat', { running: true, healthy: false })
    unregister.push(registerResumeHealthTarget(stalled.target))
    monitor.emit('resume')
    await vi.advanceTimersByTimeAsync(1_000)
    monitor.emit('unlock-screen')
    await vi.advanceTimersByTimeAsync(2_000)
    await waitForEngineResumeHealth()
    expect(stalled.restarts).toHaveLength(1)
    // Every event refreshes what the GPU can run (a driver may have changed while asleep).
    expect(invalidations).toBe(2)
  })

  it('keeps checking the other engines when one cannot be recovered', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = engine('grounding', { running: true, healthy: false, restartFails: true })
    const stalled = engine('chat', { running: true, healthy: false })
    const silent = engine('decision', { running: true, healthy: undefined as unknown as boolean })
    for (const { target } of [broken, stalled, silent])
      unregister.push(registerResumeHealthTarget(target))

    monitor.emit('resume')
    await vi.advanceTimersByTimeAsync(2_000)
    await waitForEngineResumeHealth()
    expect(broken.restarts).toHaveLength(1)
    expect(stalled.restarts).toHaveLength(1)
    // A health check that throws counts as not answering.
    expect(silent.restarts).toHaveLength(1)
    expect(error).toHaveBeenCalledWith(
      '[engine-resume-health] grounding recovery failed:',
      expect.objectContaining({ message: 'grounding would not start' })
    )
    error.mockRestore()
  })

  it('stops listening once disposed and releases anyone waiting', async () => {
    const stalled = engine('chat', { running: true, healthy: false })
    unregister.push(registerResumeHealthTarget(stalled.target))
    monitor.emit('resume')
    const waiting = waitForEngineResumeHealth()
    dispose()
    await waiting
    await vi.advanceTimersByTimeAsync(5_000)
    expect(stalled.restarts).toHaveLength(0)
    monitor.emit('resume')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(stalled.restarts).toHaveLength(0)
    expect(monitor.listenerCount('resume')).toBe(0)
    expect(monitor.listenerCount('unlock-screen')).toBe(0)
  })

  it('forgets an engine once it unregisters, but not a newer one under the same id', async () => {
    const old = engine('chat', { running: true, healthy: false })
    const offOld = registerResumeHealthTarget(old.target)
    const replacement = engine('chat', { running: true, healthy: false })
    unregister.push(registerResumeHealthTarget(replacement.target))
    offOld()

    monitor.emit('resume')
    await vi.advanceTimersByTimeAsync(2_000)
    await waitForEngineResumeHealth()
    expect(old.restarts).toHaveLength(0)
    expect(replacement.restarts).toHaveLength(1)
  })
})
