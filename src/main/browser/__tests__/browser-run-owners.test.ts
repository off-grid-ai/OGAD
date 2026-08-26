import { describe, expect, it } from 'vitest'
import { VisionGuard } from '../../vision/vision-guard'
import { BrowserJourneyRunOwners } from '../browser-run-owners'

describe('browser journey run ownership', () => {
  it('replaces and halts the old run while admitting only the new generation', () => {
    const owners = new BrowserJourneyRunOwners()
    const oldGuard = new VisionGuard()
    const old = owners.replace('chat-1', 'task-old', oldGuard).owner
    const newGuard = new VisionGuard()
    const replacement = owners.replace('chat-1', 'task-new', newGuard)

    expect(replacement.replaced).toBe(old)
    expect(oldGuard.isHalted).toBe(true)
    expect(owners.isCurrent(old)).toBe(false)
    expect(owners.isCurrent(replacement.owner)).toBe(true)
    expect(newGuard.canActuate()).toBe(true)
    expect(old.controller.signal.aborted).toBe(true)
  })

  it('refuses stale Stop and releases only the current generation', () => {
    const owners = new BrowserJourneyRunOwners()
    const old = owners.replace('chat-1', 'task-old', new VisionGuard()).owner
    const current = owners.replace('chat-1', 'task-current', new VisionGuard()).owner

    expect(owners.stop(old.taskId, 'stale stop')).toBe(false)
    expect(current.guard.canActuate()).toBe(true)
    owners.release(old)
    expect(owners.isCurrent(current)).toBe(true)
    expect(owners.stop(current.taskId, 'user stopped current task')).toBe(true)
    expect(current.guard.isHalted).toBe(true)
    expect(current.controller.signal.aborted).toBe(true)
    owners.release(current)
    expect(owners.isCurrent(current)).toBe(false)
  })

  it('keeps independent journeys independent', () => {
    const owners = new BrowserJourneyRunOwners()
    const first = owners.replace('chat-1', 'task-1', new VisionGuard()).owner
    const second = owners.replace('chat-2', 'task-2', new VisionGuard()).owner

    owners.replace('chat-1', 'task-3', new VisionGuard())

    expect(first.guard.isHalted).toBe(true)
    expect(owners.isCurrent(second)).toBe(true)
    expect(second.guard.canActuate()).toBe(true)
  })
})
