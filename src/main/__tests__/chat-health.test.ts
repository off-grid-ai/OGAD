/**
 * Guards the chat (llama-server) health decision. The motivating bug: while a
 * model loads (several seconds at -ngl 99), /health returns 503 and the server
 * isn't "ready" yet — the old logic showed a scary "down: server is not running"
 * during every cold start, so a user opened Settings mid-load and thought 0.0.29
 * was broken when the server was simply warming up. The load window MUST read as
 * 'starting', not 'down'.
 */
import { describe, it, expect } from 'vitest'
import { decideChatStatus } from '@offgrid/application'

describe('decideChatStatus', () => {
  it('ready when /health answers, detail = active model', () => {
    const r = decideChatStatus({
      healthy: true,
      loading: false,
      modelsExist: true,
      activeModel: 'gemma-4-E4B'
    })
    expect(r.status).toBe('ready')
    expect(r.detail).toBe('gemma-4-E4B')
  })

  it('the bug: alive-but-loading reads as starting, NOT down', () => {
    const r = decideChatStatus({ healthy: false, loading: true, modelsExist: true })
    expect(r.status).toBe('starting')
    expect(r.detail).toMatch(/loading/i)
  })

  it('loading takes precedence over the down fallback even if a stale error exists', () => {
    const r = decideChatStatus({
      healthy: false,
      loading: true,
      modelsExist: true,
      lastError: 'old failure'
    })
    expect(r.status).toBe('starting')
  })

  it('not_installed when no model on disk', () => {
    expect(decideChatStatus({ healthy: false, loading: false, modelsExist: false }).status).toBe(
      'not_installed'
    )
  })

  it('down (with the real reason) when the process is not running and we have one', () => {
    const r = decideChatStatus({
      healthy: false,
      loading: false,
      modelsExist: true,
      lastError: 'A required engine library is missing or could not be loaded.'
    })
    expect(r.status).toBe('down')
    expect(r.detail).toMatch(/engine library/i)
  })

  it('down with a generic message when there is no captured reason', () => {
    const r = decideChatStatus({ healthy: false, loading: false, modelsExist: true })
    expect(r.status).toBe('down')
    expect(r.detail).toMatch(/not running/i)
  })
})
