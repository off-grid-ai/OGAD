/**
 * The semantic rail's mapping and executor, through an injected runner.
 * Guards the Action-type -> helper-verb contract: every mapped type reaches
 * exactly its verb with args passed through, and everything unmapped is
 * refused before the helper is ever invoked.
 */
import { describe, expect, it, vi } from 'vitest'
import { mapActionToCommand, makeSemanticRailExecutor } from '../semantic-rail'
import type { NativeActionCommand } from '../native-helper-logic'

const action = (type: string, args: Record<string, unknown> = {}) =>
  ({ type, args }) as Parameters<typeof mapActionToCommand>[0]

describe('mapActionToCommand', () => {
  it.each([
    ['calendar', 'calendar.createEvent', { title: 'Sync', start: 's', end: 'e' }],
    ['reminder', 'reminders.create', { title: 'Send the deck', due: '18:00' }],
    ['message', 'messages.send', { to: 'Ali', text: 'hi' }],
    ['email', 'mail.send', { to: 'ali@example.com', subject: 's', body: 'b' }],
    ['open', 'open_url', { url: 'https://example.com' }]
  ] as const)('maps %s to %s with args passed through', (type, command, args) => {
    const mapped = mapActionToCommand(action(type, { ...args }))
    expect(mapped).toEqual({ ok: true, command: { command, args } })
  })

  it.each([
    ['contacts', 'contacts.search'],
    ['calendar', 'calendar.listEvents'],
    ['reminders', 'reminders.list']
  ])('maps lookup kind %s to %s and drops the discriminator', (kind, command) => {
    const mapped = mapActionToCommand(action('lookup', { kind, query: 'ali' }))
    expect(mapped).toEqual({ ok: true, command: { command, args: { query: 'ali' } } })
  })

  it('refuses a lookup with an unknown kind', () => {
    const mapped = mapActionToCommand(action('lookup', { kind: 'photos' }))
    expect(mapped.ok).toBe(false)
    if (!mapped.ok) {
      expect(mapped.error).toMatch(/photos/)
    }
  })

  it.each([['file_share'], ['web_task']])('refuses %s - it belongs to another rail', (type) => {
    const mapped = mapActionToCommand(action(type))
    expect(mapped.ok).toBe(false)
    if (!mapped.ok) {
      expect(mapped.error).toMatch(/no mapping/)
    }
  })
})

describe('makeSemanticRailExecutor', () => {
  const record = (type: string, args: Record<string, unknown> = {}) =>
    ({ type, args }) as Parameters<ReturnType<typeof makeSemanticRailExecutor>>[0]

  it('executes a mapped action through the runner and reports ok', async () => {
    const run = vi.fn(async (_cmd: NativeActionCommand) => ({ ok: true as const, result: null }))
    const execute = makeSemanticRailExecutor(run)
    const result = await execute(record('reminder', { title: 'x' }))
    expect(result).toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith({ command: 'reminders.create', args: { title: 'x' } })
  })

  it('a refused mapping never reaches the helper', async () => {
    const run = vi.fn()
    const execute = makeSemanticRailExecutor(run)
    const result = await execute(record('web_task'))
    expect(result.ok).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('a helper-reported failure becomes a result with its detail', async () => {
    const execute = makeSemanticRailExecutor(async () => ({
      ok: false as const,
      error: 'Calendar access denied'
    }))
    const result = await execute(record('calendar', { title: 'x' }))
    expect(result).toEqual({ ok: false, detail: 'Calendar access denied' })
  })

  it('a throwing runner is caught - execute never throws', async () => {
    const execute = makeSemanticRailExecutor(async () => {
      throw new Error('spawn failed')
    })
    const result = await execute(record('open', { url: 'x' }))
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/spawn failed/)
  })
})
