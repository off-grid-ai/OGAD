import type { ChatTurn } from '@offgrid/models'
import { describe, expect, it } from 'vitest'
import { DesktopTurnRepository } from '../desktop-chat-session-repository'

function turn(id: string): ChatTurn {
  return {
    id,
    conversationId: 'conversation-a',
    userMessage: { role: 'user', content: `Question ${id}` },
    status: 'completed',
    request: { operation: { type: 'text' }, request: {} }
  } as ChatTurn
}

describe('DesktopTurnRepository', () => {
  it('prefers durable turns over the in-memory cache and refreshes the cache from them', async () => {
    const durable = [turn('durable-1')]
    const written: Array<readonly ChatTurn[]> = []
    let durableReads = 0
    const repository = new DesktopTurnRepository({
      readChatSessionTurns: async () => {
        durableReads += 1
        return durable
      },
      writeChatSessionTurns: async (_conversationId, turns) => {
        written.push(turns)
      }
    })

    await repository.write('conversation-a', [turn('cached-1')])
    expect(written).toHaveLength(1)
    expect(written[0]!.map((entry) => entry.id)).toEqual(['cached-1'])

    const read = await repository.read('conversation-a')
    expect(read.map((entry) => entry.id)).toEqual(['durable-1'])
    expect(durableReads).toBe(1)
  })

  it('falls back to the cache when the durable store returns nothing', async () => {
    const repository = new DesktopTurnRepository({
      readChatSessionTurns: async () => undefined as unknown as ChatTurn[]
    })
    await repository.write('conversation-a', [turn('cached-1')])
    const read = await repository.read('conversation-a')
    expect(read.map((entry) => entry.id)).toEqual(['cached-1'])
    expect(await repository.read('conversation-b')).toEqual([])
  })

  it('works with an absent boundary (optional persistence methods undefined)', async () => {
    const repository = new DesktopTurnRepository()
    expect(await repository.read('conversation-a')).toEqual([])
    await repository.write('conversation-a', [turn('cached-1'), turn('cached-2')])
    const read = await repository.read('conversation-a')
    expect(read.map((entry) => entry.id)).toEqual(['cached-1', 'cached-2'])
    repository.invalidate('conversation-a')
    expect(await repository.read('conversation-a')).toEqual([])
  })
})
