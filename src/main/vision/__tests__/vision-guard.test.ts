/**
 * The supervised-tier guard's priority rules: the kill switch is terminal and
 * outranks everything, an explicit command pauses until Resume, and
 * the step budget halts a flailing model. canActuate() is the one gate the
 * loop checks - these tests pin exactly when it opens and closes.
 */
import { describe, expect, it } from 'vitest'
import { VisionGuard } from '../vision-guard'

describe('VisionGuard', () => {
  it('actuates while running and counts only dispatched steps', () => {
    const guard = new VisionGuard(5)
    expect(guard.canActuate()).toBe(true)
    guard.countStep()
    guard.countStep()
    expect(guard.snapshot().steps).toBe(2)
  })

  it('the kill switch halts immediately and permanently', () => {
    const guard = new VisionGuard()
    guard.halt()
    expect(guard.canActuate()).toBe(false)
    expect(guard.isHalted).toBe(true)
    // Terminal: neither resume nor a pause can revive a halted session.
    guard.resume()
    guard.pauseForUser()
    expect(guard.isHalted).toBe(true)
    expect(guard.canActuate()).toBe(false)
  })

  it('an explicit Take Over command pauses until Resume', async () => {
    const guard = new VisionGuard()
    guard.pauseForUser('you selected Take Over')
    expect(guard.canActuate()).toBe(false)
    expect(guard.isPaused).toBe(true)
    expect(guard.snapshot().reason).toBe('you selected Take Over')
    const resumed = guard.waitUntilRunnable()
    guard.resume()
    expect(await resumed).toMatchObject({ state: 'running' })
    expect(guard.canActuate()).toBe(true)
  })

  it('the kill switch outranks a pause - halting a paused session stays halted', () => {
    const guard = new VisionGuard()
    guard.pauseForUser()
    guard.halt('stopped with Esc')
    guard.resume() // must NOT bring it back
    expect(guard.isHalted).toBe(true)
    expect(guard.snapshot().reason).toBe('stopped with Esc')
  })

  it('a pause never overrides a halt', () => {
    const guard = new VisionGuard()
    guard.halt()
    guard.pauseForUser('you selected Take Over')
    expect(guard.isHalted).toBe(true)
    expect(guard.isPaused).toBe(false)
  })

  it('the step budget halts a flailing model', () => {
    const guard = new VisionGuard(3)
    for (let i = 0; i < 3; i += 1) {
      expect(guard.canActuate()).toBe(true)
      guard.countStep()
    }
    expect(guard.canActuate()).toBe(false)
    expect(guard.isHalted).toBe(true)
    expect(guard.snapshot().reason).toMatch(/3-step limit/)
  })

  it('resume on a running session is a no-op, not a step reset', () => {
    const guard = new VisionGuard()
    guard.countStep()
    guard.resume()
    expect(guard.snapshot()).toMatchObject({ state: 'running', steps: 1 })
  })
})
