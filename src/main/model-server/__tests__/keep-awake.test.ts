import { describe, expect, it } from 'vitest'
import { TeamKeepAwake } from '../keep-awake'

/** The host's sleep blocker at its boundary: records what the gateway asks of it. */
function recordingBlocker(): { events: string[]; start: () => number; stop: (id: number) => void } {
  const events: string[] = []
  let next = 0
  return {
    events,
    start: () => {
      events.push('start')
      return ++next
    },
    stop: (id) => events.push(`stop ${id}`)
  }
}

describe('keeping a Team server awake', () => {
  it('holds while requests run and lets go a grace period after the last one', async () => {
    const blocker = recordingBlocker()
    const awake = new TeamKeepAwake(blocker, 30)
    awake.update(true, true)
    awake.update(true, true)
    expect(blocker.events).toEqual(['start'])
    awake.update(true, false)
    expect(awake.held).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(blocker.events).toEqual(['start', 'stop 1'])
    expect(awake.held).toBe(false)
  })

  it('a request within the grace period keeps the same hold', async () => {
    const blocker = recordingBlocker()
    const awake = new TeamKeepAwake(blocker, 30)
    awake.update(true, true)
    awake.update(true, false)
    awake.update(true, true)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(blocker.events).toEqual(['start'])
    awake.release()
    expect(blocker.events).toEqual(['start', 'stop 1'])
  })

  it('never holds in single mode, and lets go at once on a switch to it', () => {
    const blocker = recordingBlocker()
    const awake = new TeamKeepAwake(blocker, 60_000)
    awake.update(false, true)
    expect(blocker.events).toEqual([])
    awake.update(true, true)
    awake.update(false, true)
    expect(blocker.events).toEqual(['start', 'stop 1'])
  })
})
