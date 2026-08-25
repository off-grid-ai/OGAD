/**
 * The takeover handoff: a parked task broadcasts to the watched pane, resumes
 * or cancels on the user's verdict, clears the surface either way, and never
 * wedges when there is no pane to wait on.
 */
import { describe, expect, it, vi } from 'vitest'
import { TakeoverCoordinator } from '../takeover'

describe('TakeoverCoordinator', () => {
  it('parks, broadcasts the request, and resolves resumed on the user verdict', async () => {
    const coordinator = new TakeoverCoordinator()
    const onRequest = vi.fn()
    const onClear = vi.fn()
    coordinator.registerSurface(onRequest, onClear)

    const parked = coordinator.waitForTakeover('task_1', 'sign in to continue')
    expect(onRequest).toHaveBeenCalledWith({ taskId: 'task_1', why: 'sign in to continue' })
    expect(coordinator.pendingCount()).toBe(1)

    expect(coordinator.resolve('task_1', 'resumed')).toBe(true)
    await expect(parked).resolves.toBe('resumed')
    expect(onClear).toHaveBeenCalledWith('task_1')
    expect(coordinator.pendingCount()).toBe(0)
  })

  it('carries a cancel back to the loop', async () => {
    const coordinator = new TakeoverCoordinator()
    coordinator.registerSurface(vi.fn(), vi.fn())
    const parked = coordinator.waitForTakeover('task_2', 'pay')
    coordinator.resolve('task_2', 'cancelled')
    await expect(parked).resolves.toBe('cancelled')
  })

  it('resolves immediately when no pane is registered - a task never wedges on a missing UI', async () => {
    const coordinator = new TakeoverCoordinator()
    await expect(coordinator.waitForTakeover('task_3', 'login')).resolves.toBe('resumed')
    expect(coordinator.pendingCount()).toBe(0)
  })

  it('a stale verdict for an unknown task is refused, not thrown', () => {
    const coordinator = new TakeoverCoordinator()
    coordinator.registerSurface(vi.fn(), vi.fn())
    expect(coordinator.resolve('ghost', 'resumed')).toBe(false)
  })

  it('an unregistered surface stops receiving parks', async () => {
    const coordinator = new TakeoverCoordinator()
    const onRequest = vi.fn()
    const off = coordinator.registerSurface(onRequest, vi.fn())
    off()
    await expect(coordinator.waitForTakeover('task_4', 'x')).resolves.toBe('resumed')
    expect(onRequest).not.toHaveBeenCalled()
  })
})
