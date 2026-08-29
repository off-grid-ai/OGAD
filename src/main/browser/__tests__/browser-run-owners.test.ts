import { describe, expect, it } from 'vitest'
import { VisionGuard } from '../../vision/vision-guard'
import { BrowserJourneyRunOwners } from '../browser-run-owners'

describe('browser journey run ownership', () => {
  it('replaces and halts the old run while admitting only the new generation', () => {
    const owners = new BrowserJourneyRunOwners()
    const oldGuard = new VisionGuard({ taskId: 'task-old', kind: 'web_use' })
    const old = owners.replace('chat-1', 'task-old', oldGuard).owner
    const newGuard = new VisionGuard({ taskId: 'task-new', kind: 'web_use' })
    const replacement = owners.replace('chat-1', 'task-new', newGuard)

    expect(replacement.replaced).toBe(old)
    expect(oldGuard.isHalted).toBe(true)
    expect(owners.isCurrent(old)).toBe(false)
    expect(owners.isCurrent(replacement.owner)).toBe(true)
    expect(newGuard.markObservationReady()).toBe(true)
    expect(newGuard.canActuate()).toBe(true)
    expect(old.controller.signal.aborted).toBe(true)
  })

  it('releases only the current generation', () => {
    const owners = new BrowserJourneyRunOwners()
    const old = owners.replace(
      'chat-1',
      'task-old',
      new VisionGuard({ taskId: 'task-old', kind: 'web_use' })
    ).owner
    const current = owners.replace(
      'chat-1',
      'task-current',
      new VisionGuard({ taskId: 'task-current', kind: 'web_use' })
    ).owner

    expect(current.guard.markObservationReady()).toBe(true)
    expect(current.guard.canActuate()).toBe(true)
    owners.release(old)
    expect(owners.isCurrent(current)).toBe(true)
    owners.release(current)
    expect(owners.isCurrent(current)).toBe(false)
  })

  it('keeps independent journeys independent', () => {
    const owners = new BrowserJourneyRunOwners()
    const first = owners.replace(
      'chat-1',
      'task-1',
      new VisionGuard({ taskId: 'task-1', kind: 'web_use' })
    ).owner
    const second = owners.replace(
      'chat-2',
      'task-2',
      new VisionGuard({ taskId: 'task-2', kind: 'web_use' })
    ).owner

    owners.replace('chat-1', 'task-3', new VisionGuard({ taskId: 'task-3', kind: 'web_use' }))

    expect(first.guard.isHalted).toBe(true)
    expect(owners.isCurrent(second)).toBe(true)
    expect(second.guard.markObservationReady()).toBe(true)
    expect(second.guard.canActuate()).toBe(true)
  })
})
