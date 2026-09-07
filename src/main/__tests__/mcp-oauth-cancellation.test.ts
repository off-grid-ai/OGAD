import { describe, expect, it, vi } from 'vitest'
import { beginOAuthAuthorization, cancelOAuthAuthorization } from '../mcp-oauth-cancellation'

describe('connector OAuth cancellation registry', () => {
  it('cancels only the named connector and clears the registration', () => {
    const first = vi.fn()
    const second = vi.fn()
    beginOAuthAuthorization(101, first)
    beginOAuthAuthorization(202, second)

    expect(cancelOAuthAuthorization(101)).toBe(true)
    expect(first).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Authorization cancelled' })
    )
    expect(second).not.toHaveBeenCalled()
    expect(cancelOAuthAuthorization(101)).toBe(false)

    cancelOAuthAuthorization(202)
  })

  it('cancels an older attempt when a connector starts a new one', () => {
    const older = vi.fn()
    const newer = vi.fn()
    beginOAuthAuthorization(303, older)
    const finishNewer = beginOAuthAuthorization(303, newer)

    expect(older).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Authorization superseded by a newer request' })
    )
    finishNewer()
    expect(cancelOAuthAuthorization(303)).toBe(false)
    expect(newer).not.toHaveBeenCalled()
  })

  it('does not let an older completion clear a newer attempt', () => {
    const older = vi.fn()
    const newer = vi.fn()
    const finishOlder = beginOAuthAuthorization(404, older)
    beginOAuthAuthorization(404, newer)

    finishOlder()
    expect(cancelOAuthAuthorization(404)).toBe(true)
    expect(newer).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Authorization cancelled' })
    )
  })
})
