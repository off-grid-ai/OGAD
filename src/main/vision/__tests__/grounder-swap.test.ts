import { describe, expect, it } from 'vitest'
import { runRestoredModelSwap } from '../grounder-swap'

describe('runRestoredModelSwap', () => {
  it('restores the chat model after a successful Computer Use run', async () => {
    const events: string[] = []
    const ticks = [0, 5, 7, 18, 20, 24]
    const result = await runRestoredModelSwap({
      swapIn: async () => void events.push('swap-in'),
      run: async () => {
        events.push('run')
        return 'done'
      },
      restore: async () => void events.push('restore'),
      now: () => ticks.shift() ?? 24
    })

    expect(events).toEqual(['swap-in', 'run', 'restore'])
    expect(result.result).toBe('done')
    expect(result.timing).toEqual({ swapInMs: 5, runMs: 11, swapOutMs: 4 })
  })

  it('restores the chat model when swap-in fails after changing the active file', async () => {
    const events: string[] = []
    const failure = new Error('projector rejected')

    await expect(
      runRestoredModelSwap({
        swapIn: async () => {
          events.push('active file changed')
          throw failure
        },
        run: async () => {
          events.push('run')
          return 'unreachable'
        },
        restore: async () => void events.push('chat restored')
      })
    ).rejects.toBe(failure)
    expect(events).toEqual(['active file changed', 'chat restored'])
  })

  it('reports a failed restoration instead of leaving the engine state ambiguous', async () => {
    await expect(
      runRestoredModelSwap({
        swapIn: async () => {},
        run: async () => {
          throw new Error('task failed')
        },
        restore: async () => {
          throw new Error('restore failed')
        }
      })
    ).rejects.toThrow('failed to restore the chat model')
  })
})
