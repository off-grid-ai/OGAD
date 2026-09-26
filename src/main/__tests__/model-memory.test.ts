import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareModelMemory, registerModelEvictor, withExclusiveModelMemory } from '../model-memory'

const events: string[] = []
beforeEach(() => {
  events.length = 0
  for (const role of ['chat', 'decision', 'grounding'] as const) {
    registerModelEvictor(role, async () => {
      events.push(`stop:${role}`)
    })
  }
})

describe('exclusive model memory for Kev tasks', () => {
  it('awaits eviction and permits repeated Decision, reasoning, and specialist swaps', async () => {
    await withExclusiveModelMemory(async () => {
      for (const role of [
        'decision',
        'chat',
        'grounding',
        'decision',
        'chat',
        'decision'
      ] as const) {
        await prepareModelMemory(role)
        events.push(`load:${role}`)
      }
    })
    expect(events).toEqual([
      'stop:chat',
      'stop:grounding',
      'load:decision',
      'stop:decision',
      'stop:grounding',
      'load:chat',
      'stop:chat',
      'stop:decision',
      'load:grounding',
      'stop:chat',
      'stop:grounding',
      'load:decision',
      'stop:decision',
      'stop:grounding',
      'load:chat',
      'stop:chat',
      'stop:grounding',
      'load:decision',
      'stop:decision',
      'stop:grounding'
    ])
  })

  it('keeps the normal residency policy outside an exclusive task', async () => {
    await prepareModelMemory('chat')
    expect(events).toEqual([])
  })

  it('cleans up on failure and does not reload chat or leave the policy enabled', async () => {
    await expect(
      withExclusiveModelMemory(async () => {
        throw new Error('load failed')
      })
    ).rejects.toThrow('load failed')
    expect(events).toEqual(['stop:decision', 'stop:grounding'])
    events.length = 0
    await prepareModelMemory('decision')
    expect(events).toEqual([])
  })

  it('does not allocate the next model until the previous process has stopped', async () => {
    let release!: () => void
    const stopped = new Promise<void>((resolve) => {
      release = resolve
    })
    registerModelEvictor('chat', () => stopped)
    const load = vi.fn()
    const run = withExclusiveModelMemory(async () => {
      await prepareModelMemory('decision')
      load()
    })
    await Promise.resolve()
    expect(load).not.toHaveBeenCalled()
    release()
    await run
    expect(load).toHaveBeenCalledOnce()
  })
})
