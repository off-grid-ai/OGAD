import { describe, expect, it } from 'vitest'
import { OFFGRID_TASK_ORIGIN_META_KEY, parseMcpTaskOrigin } from '../mcp-task-origin'

describe('authenticated MCP task origin', () => {
  it('keeps a Mobile task in its portable chat', () => {
    expect(
      parseMcpTaskOrigin({
        [OFFGRID_TASK_ORIGIN_META_KEY]: {
          conversationId: 'conversation:mobile-107',
          deviceId: 'mobile:alice-phone',
          deviceName: "Alice's phone"
        }
      })
    ).toEqual({
      conversationId: 'conversation:mobile-107',
      deviceId: 'mobile:alice-phone',
      deviceName: "Alice's phone"
    })
  })

  it.each([
    undefined,
    {},
    { [OFFGRID_TASK_ORIGIN_META_KEY]: null },
    { [OFFGRID_TASK_ORIGIN_META_KEY]: { conversationId: '../another-chat' } },
    { [OFFGRID_TASK_ORIGIN_META_KEY]: { conversationId: 'chat id with spaces' } },
    { [OFFGRID_TASK_ORIGIN_META_KEY]: { conversationId: 'x'.repeat(161) } }
  ])('rejects malformed or unsafe metadata: %j', (meta) => {
    expect(parseMcpTaskOrigin(meta)).toBeUndefined()
  })

  it('drops invalid optional device facts without losing the valid chat owner', () => {
    expect(
      parseMcpTaskOrigin({
        [OFFGRID_TASK_ORIGIN_META_KEY]: {
          conversationId: 'chat-107',
          deviceId: 'not a portable device id',
          deviceName: 'bad\u0000name'
        }
      })
    ).toEqual({ conversationId: 'chat-107' })
  })
})
