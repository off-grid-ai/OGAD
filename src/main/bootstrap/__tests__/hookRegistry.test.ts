/**
 * Unit tests for the function-hook seam. This is the pure in-memory registry pro
 * features register against during activation; core calls a hook when present and
 * falls back to undefined when absent. High blast radius: chat-prompt augmentation
 * and universal-search sources both route through it.
 */
import { describe, it, expect } from 'vitest'
import {
  registerHook,
  unregisterHook,
  hasHook,
  callHook,
  callHookAsync,
  HOOKS
} from '../hookRegistry'

describe('hookRegistry', () => {
  it('registers a hook and callHook returns its result', () => {
    registerHook('t.sum', (a: number, b: number) => a + b)
    expect(callHook<number>('t.sum', 2, 3)).toBe(5)
  })

  it('forwards all arguments to the registered fn', () => {
    let seen: unknown[] = []
    registerHook('t.args', (...args: unknown[]) => {
      seen = args
      return 'ok'
    })
    callHook('t.args', 'x', 1, true)
    expect(seen).toEqual(['x', 1, true])
  })

  it('returns undefined for an unregistered key', () => {
    expect(callHook('t.never-registered')).toBeUndefined()
  })

  it('overwrites (replaces) a hook on re-register, keeping the latest', () => {
    registerHook('t.replace', () => 'first')
    expect(callHook('t.replace')).toBe('first')
    registerHook('t.replace', () => 'second')
    expect(callHook('t.replace')).toBe('second')
  })

  it('callHookAsync awaits an async hook and returns its resolved value', async () => {
    registerHook('t.async', async (n: number) => n * 10)
    await expect(callHookAsync<number>('t.async', 4)).resolves.toBe(40)
  })

  it('callHookAsync returns undefined for an unregistered key', async () => {
    await expect(callHookAsync('t.async-never')).resolves.toBeUndefined()
  })

  it('callHookAsync also resolves a synchronous hook result', async () => {
    registerHook('t.sync-via-async', () => 'plain')
    await expect(callHookAsync<string>('t.sync-via-async')).resolves.toBe('plain')
  })

  it('hasHook reports registration and unregisterHook removes it', () => {
    expect(hasHook('t.presence')).toBe(false)
    registerHook('t.presence', () => 1)
    expect(hasHook('t.presence')).toBe(true)
    unregisterHook('t.presence')
    expect(hasHook('t.presence')).toBe(false)
    expect(callHook('t.presence')).toBeUndefined()
  })

  it('hasHook is true even for a hook that returns undefined', () => {
    registerHook('t.returns-undefined', () => undefined)
    expect(hasHook('t.returns-undefined')).toBe(true)
    expect(callHook('t.returns-undefined')).toBeUndefined()
    unregisterHook('t.returns-undefined')
  })

  it('unregisterHook is a no-op for an unknown key', () => {
    expect(() => unregisterHook('t.never')).not.toThrow()
  })

  it('exposes the known hook-name constants core and pro share', () => {
    expect(HOOKS.chatAugmentContext).toBe('chat.augmentContext')
    expect(HOOKS.searchExtraSources).toBe('search.extraSources')
    expect(HOOKS.actionsProposeApproval).toBe('actions:proposeApproval')
    expect(HOOKS.legacyMcpProposeApproval).toBe('mcp:proposeApproval')
  })
})
