/**
 * Read-back verification, through a scripted helper boundary. Everything
 * fails closed: helper errors, malformed results, and missing args verify
 * as false so the retry policy - not optimism - decides what happens next.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ActionRecord } from '@offgrid/use'
import { calendarVerifyWindow, listContainsTitle, makeReadBackVerifiers } from '../verification'
import type { NativeActionCommand } from '../native-helper-logic'

const action = (type: string, args: Record<string, unknown>): ActionRecord =>
  ({ type, args }) as ActionRecord

describe('listContainsTitle', () => {
  it('matches an exact title in the helper shape', () => {
    const result = { reminders: [{ id: 'r1', title: 'Send the deck' }] }
    expect(listContainsTitle(result, 'reminders', 'Send the deck')).toBe(true)
    expect(listContainsTitle(result, 'reminders', 'send the deck')).toBe(false)
  })

  it('fails closed on malformed shapes', () => {
    expect(listContainsTitle(null, 'reminders', 'x')).toBe(false)
    expect(listContainsTitle({ reminders: 'nope' }, 'reminders', 'x')).toBe(false)
    expect(listContainsTitle({ events: [{ title: 'x' }] }, 'reminders', 'x')).toBe(false)
    expect(listContainsTitle({ reminders: [null, 42] }, 'reminders', 'x')).toBe(false)
  })
})

describe('calendarVerifyWindow', () => {
  it('pads the event range by a minute on both sides', () => {
    const window = calendarVerifyWindow({
      start: '2026-08-14T09:30:00.000Z',
      end: '2026-08-14T10:00:00.000Z'
    })
    expect(window).toEqual({
      start: '2026-08-14T09:29:00.000Z',
      end: '2026-08-14T10:01:00.000Z'
    })
  })

  it('defaults a missing end to one hour after start (the helper default)', () => {
    const window = calendarVerifyWindow({ start: '2026-08-14T09:30:00.000Z' })
    expect(window?.end).toBe('2026-08-14T10:31:00.000Z')
  })

  it('an unparseable start means nothing sane to verify against', () => {
    expect(calendarVerifyWindow({ start: 'whenever' })).toBeUndefined()
    expect(calendarVerifyWindow({})).toBeUndefined()
  })
})

describe('makeReadBackVerifiers', () => {
  it('a reminder verifies true when the list shows it, false when absent', async () => {
    const run = vi.fn(async () => ({
      ok: true as const,
      result: { reminders: [{ title: 'Send the deck' }] }
    }))
    const verifiers = makeReadBackVerifiers(run)
    expect(await verifiers.reminder(action('reminder', { title: 'Send the deck' }))).toBe(true)
    expect(await verifiers.reminder(action('reminder', { title: 'Something else' }))).toBe(false)
    expect(run).toHaveBeenCalledWith({ command: 'reminders.list', args: {} })
  })

  it('a calendar event verifies inside its padded window', async () => {
    const seen: NativeActionCommand[] = []
    const run = vi.fn(async (cmd: NativeActionCommand) => {
      seen.push(cmd)
      return { ok: true as const, result: { events: [{ title: 'Standup' }] } }
    })
    const verifiers = makeReadBackVerifiers(run)
    const verified = await verifiers.calendar(
      action('calendar', { title: 'Standup', start: '2026-08-14T09:30:00.000Z' })
    )
    expect(verified).toBe(true)
    expect(seen[0]?.command).toBe('calendar.listEvents')
    expect(seen[0]?.args).toEqual({
      start: '2026-08-14T09:29:00.000Z',
      end: '2026-08-14T10:31:00.000Z'
    })
  })

  it('a calendar event with an unparseable start verifies false without listing', async () => {
    const run = vi.fn()
    const verifiers = makeReadBackVerifiers(run)
    expect(await verifiers.calendar(action('calendar', { title: 'x', start: 'whenever' }))).toBe(
      false
    )
    expect(run).not.toHaveBeenCalled()
  })

  it('a helper failure verifies false, never optimistic', async () => {
    const run = vi.fn(async () => ({ ok: false as const, error: 'Reminders access denied' }))
    const verifiers = makeReadBackVerifiers(run)
    expect(await verifiers.reminder(action('reminder', { title: 'x' }))).toBe(false)
  })

  it('a missing or empty title fails closed without calling the helper', async () => {
    const run = vi.fn()
    const verifiers = makeReadBackVerifiers(run)
    expect(await verifiers.reminder(action('reminder', {}))).toBe(false)
    expect(
      await verifiers.calendar(action('calendar', { start: '2026-08-14T09:30:00.000Z' }))
    ).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })
})
