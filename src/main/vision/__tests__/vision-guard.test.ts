/**
 * The supervised-tier guard's priority rules: the kill switch is terminal and
 * outranks everything, an explicit command pauses until Resume, and
 * the step budget halts a flailing model. canActuate() is the one gate the
 * loop checks - these tests pin exactly when it opens and closes.
 */
import { describe, expect, it } from 'vitest'
import { VisionGuard } from '../vision-guard'

function createGuard(maxSteps?: number): VisionGuard {
  return new VisionGuard({ taskId: 'guard-test', kind: 'computer_use', maxSteps })
}

describe('VisionGuard', () => {
  it('actuates while running and counts only dispatched steps', () => {
    const guard = new VisionGuard({ taskId: 'guard-test', kind: 'computer_use', maxSteps: 5 })
    expect(guard.markObservationReady()).toBe(true)
    expect(guard.canActuate()).toBe(true)
    guard.countStep()
    guard.countStep()
    expect(guard.snapshot().steps).toBe(2)
  })

  it('the kill switch halts immediately and permanently', () => {
    const guard = createGuard()
    guard.halt()
    expect(guard.canActuate()).toBe(false)
    expect(guard.isHalted).toBe(true)
    // Terminal: neither resume nor a pause can revive a halted session.
    guard.resume()
    guard.takeOver()
    expect(guard.isHalted).toBe(true)
    expect(guard.canActuate()).toBe(false)
  })

  it('an explicit Take Over command pauses until Resume', async () => {
    const guard = createGuard()
    guard.takeOver('you selected Take Over')
    expect(guard.canActuate()).toBe(false)
    expect(guard.isPaused).toBe(true)
    expect(guard.snapshot().inputLease.owner).toBe('user')
    const resumed = guard.waitUntilRunnable()
    guard.resume()
    expect(await resumed).toMatchObject({ status: 'running' })
    expect(guard.canCapture).toBe(true)
    expect(guard.canActuate()).toBe(false)
    expect(guard.markObservationReady()).toBe(true)
  })

  it('call_user revokes agent input until the user selects Continue', async () => {
    const guard = createGuard()
    guard.requestUser('Enter the one-time code')

    expect(guard.canActuate()).toBe(false)
    expect(guard.isPaused).toBe(true)
    expect(guard.snapshot()).toMatchObject({
      status: 'waiting_for_user',
      reason: 'Enter the one-time code'
    })

    const continued = guard.waitUntilRunnable()
    guard.resume()
    expect(await continued).toMatchObject({ status: 'running' })
    expect(guard.canCapture).toBe(true)
    expect(guard.canActuate()).toBe(false)
    expect(guard.markObservationReady()).toBe(true)
  })

  it('cancels a parked wait when the run aborts', async () => {
    const guard = createGuard()
    const request = new AbortController()
    guard.requestUser('Enter the password')

    const waiting = guard.waitUntilRunnable(request.signal)
    request.abort('the run was replaced')

    await expect(waiting).rejects.toBe('the run was replaced')
  })

  it('requires a fresh observation before verified completion', () => {
    const guard = createGuard()
    expect(guard.markObservationReady()).toBe(true)
    expect(guard.beginVerification()).toBe(true)
    expect(guard.complete()).toBe(false)
    expect(guard.canCapture).toBe(true)
    expect(guard.markObservationReady()).toBe(true)
    expect(guard.complete()).toBe(true)
    expect(guard.isHalted).toBe(true)
  })

  it('the kill switch outranks a pause - halting a paused session stays halted', () => {
    const guard = createGuard()
    guard.takeOver()
    guard.halt('stopped with Esc')
    guard.resume() // must NOT bring it back
    expect(guard.isHalted).toBe(true)
    expect(guard.snapshot().status).toBe('stopped')
  })

  it('a pause never overrides a halt', () => {
    const guard = createGuard()
    guard.halt()
    guard.takeOver('you selected Take Over')
    expect(guard.isHalted).toBe(true)
    expect(guard.isPaused).toBe(false)
  })

  it('the step budget halts a flailing model', () => {
    const guard = new VisionGuard({ taskId: 'guard-test', kind: 'computer_use', maxSteps: 3 })
    expect(guard.markObservationReady()).toBe(true)
    for (let i = 0; i < 3; i += 1) {
      expect(guard.canActuate()).toBe(true)
      guard.countStep()
    }
    expect(guard.canActuate()).toBe(false)
    expect(guard.isHalted).toBe(true)
    expect(guard.snapshot().reason).toMatch(/3-step limit/)
  })

  it('resume on a running session is a no-op, not a step reset', () => {
    const guard = createGuard()
    guard.countStep()
    guard.resume()
    expect(guard.snapshot()).toMatchObject({ status: 'running', steps: 1 })
  })
})
