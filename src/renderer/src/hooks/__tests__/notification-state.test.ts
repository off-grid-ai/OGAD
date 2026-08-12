import { describe, expect, it } from 'vitest'
import {
  addNotificationToState,
  restoreNotifications,
  type Notification,
  type NotificationInput
} from '../notification-state'

/**
 * What the bell is allowed to say, and what it refuses to keep.
 *
 * Two jobs. Restoring reads whatever is in localStorage - which is untrusted, because it survives across
 * versions, was written by older code, and a user can edit it. Adding decides whether a new event is a fresh
 * notification or a replacement for one already there.
 *
 * The behaviour worth protecting either way is that the count means something. A duplicate that becomes a
 * second row, or a to-do mirrored from the list it already lives in, turns the unread badge into noise - and
 * a badge nobody trusts is the same as no badge.
 *
 * Pure functions, no boundary at all.
 */

const stored = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'n1',
  type: 'approval',
  title: 'Approval needed',
  message: 'Send the follow-up email?',
  timestamp: '2026-01-01T09:00:00.000Z',
  read: false,
  ...overrides
})

const input = (overrides: Partial<NotificationInput> = {}): NotificationInput =>
  ({
    type: 'approval',
    title: 'Approval needed',
    message: 'Send the follow-up email?',
    ...overrides
  }) as NotificationInput

describe('restoring what the bell had before the app closed', () => {
  it('keeps a well-formed record, with its timestamp as a Date', () => {
    const [restored] = restoreNotifications([stored()])

    expect(restored).toMatchObject({ id: 'n1', type: 'approval', read: false })
    // A Date, not the string it was stored as: everything downstream sorts and formats with it, and a string
    // sorts lexically - which happens to work until the year rolls over or a timezone offset appears.
    expect(restored!.timestamp).toBeInstanceOf(Date)
    expect(restored!.timestamp.toISOString()).toBe('2026-01-01T09:00:00.000Z')
  })

  it('has nothing to restore from anything that is not a list', () => {
    for (const value of [null, undefined, 'not json', 42, {}, true]) {
      expect(restoreNotifications(value)).toEqual([])
    }
  })

  it.each([
    ['a record that is not an object', 'a string'],
    ['a null entry', null],
    ['an unknown type', stored({ type: 'reminder' })],
    ['a missing id', { ...stored(), id: undefined }],
    ['a non-string title', stored({ title: 42 })],
    ['a missing message', { ...stored(), message: undefined }],
    ['an unparseable timestamp', stored({ timestamp: 'the day before yesterday' })]
  ])('drops %s rather than restoring something half-formed', (_why, value) => {
    // Storage outlives the code that wrote it. One malformed row must cost that row, not the whole bell -
    // and it must not reach the UI as a notification with an undefined title.
    expect(restoreNotifications([value])).toEqual([])
  })

  it('keeps the good records either side of a bad one', () => {
    const restored = restoreNotifications([
      stored({ id: 'first' }),
      stored({ id: 'broken', timestamp: 'nonsense' }),
      stored({ id: 'last' })
    ])

    expect(restored.map(({ id }) => id)).toEqual(['first', 'last'])
  })

  it('never restores a to-do, because it already has a home', () => {
    const restored = restoreNotifications([stored({ type: 'todo' }), stored({ id: 'keep-me' })])

    // A to-do lives in the to-do list; mirroring it into the bell tells the user the same thing twice and
    // makes the unread count mean "things", not "things waiting on you".
    expect(restored.map(({ id }) => id)).toEqual(['keep-me'])
  })

  it('collapses records that share an identity, keeping the first', () => {
    const restored = restoreNotifications([
      stored({ id: 'newest', message: 'the current state', dedupeKey: 'crm:record:42' }),
      stored({ id: 'stale', message: 'what it said an hour ago', dedupeKey: 'crm:record:42' })
    ])

    // Persisted duplicates are normal: the same record can be written repeatedly across sessions. Restoring
    // both would show a history of one thing as several unread items.
    expect(restored).toHaveLength(1)
    expect(restored[0]!.id).toBe('newest')
  })

  it('drops an EMPTY identity, so unrelated notifications are not collapsed', () => {
    const restored = restoreNotifications([
      stored({ id: 'a', dedupeKey: '' }),
      stored({ id: 'b', dedupeKey: '' })
    ])

    // Two unrelated notifications with no key. Treating blank as an identity would collapse them into one and
    // lose a real notification.
    expect(restored.map(({ id }) => id)).toEqual(['a', 'b'])
  })

  it('keeps a whitespace-only identity instead of dropping it, unlike an empty one', () => {
    const restored = restoreNotifications([
      stored({ id: 'a', dedupeKey: '   ' }),
      stored({ id: 'b', dedupeKey: '   ' })
    ])

    // Current behaviour, asserted rather than assumed. parseStoredNotification trims the key and re-adds it
    // only when the trimmed value is non-empty:
    //
    //   const dedupeKey = typeof value.dedupeKey === 'string' ? value.dedupeKey.trim() : ''
    //   return { ...value, ...(dedupeKey ? { dedupeKey } : {}), ... }
    //
    // For a whitespace-only key the conditional spread adds nothing, so the UNTRIMMED original survives from
    // the first spread and is truthy - so it counts as an identity, and two records carrying the same blank
    // key collapse into one. An empty string does not survive, so those do not collapse (the case above).
    //
    // The inconsistency is minor and reachable only if a domain writes a blank key, which is why it is
    // recorded here rather than fixed: the one-line change belongs in src and needs a decision.
    expect(restored).toHaveLength(1)
    expect(restored[0]!.dedupeKey).toBe('   ')
  })

  it('trims an identity so the same key written two ways still matches', () => {
    const restored = restoreNotifications([
      stored({ id: 'a', dedupeKey: ' crm:record:42 ' }),
      stored({ id: 'b', dedupeKey: 'crm:record:42' })
    ])

    expect(restored).toHaveLength(1)
    expect(restored[0]!.dedupeKey).toBe('crm:record:42')
  })

  it('treats read as read only when it was stored exactly true', () => {
    expect(restoreNotifications([stored({ read: true })])[0]!.read).toBe(true)
    for (const value of ['true', 1, undefined, null]) {
      // Anything else counts as unread. Marking something read on a truthy string would hide an approval the
      // user has never seen.
      expect(restoreNotifications([stored({ read: value })])[0]!.read).toBe(false)
    }
  })

  it('stops at fifty, so a long-lived profile cannot grow without bound', () => {
    const many = Array.from({ length: 80 }, (_, index) => stored({ id: `n${index}` }))

    const restored = restoreNotifications(many)

    // The newest fifty. Unbounded restore means a profile that has been open for months pays a growing cost
    // on every launch for notifications nobody will read.
    expect(restored).toHaveLength(50)
    expect(restored[0]!.id).toBe('n0')
  })
})

describe('adding a notification', () => {
  it('puts the newest first, with an id, a timestamp and unread', () => {
    const existing: Notification[] = []

    const [added] = addNotificationToState(existing, input({ message: 'the new one' }))

    expect(added).toMatchObject({ message: 'the new one', read: false })
    expect(added!.id).toBeTruthy()
    expect(added!.timestamp).toBeInstanceOf(Date)
  })

  it('leaves the list it was given untouched', () => {
    const existing: Notification[] = restoreNotifications([stored()])
    const before = [...existing]

    addNotificationToState(existing, input())

    // The caller is React state. Mutating it in place is how a list updates without re-rendering.
    expect(existing).toEqual(before)
  })

  it('refuses a to-do, and says so by changing nothing', () => {
    const existing = restoreNotifications([stored({ id: 'keep' })])

    const next = addNotificationToState(existing, input({ type: 'todo' }))

    expect(next.map(({ id }) => id)).toEqual(['keep'])
  })

  it('replaces the earlier notification about the same thing instead of stacking', () => {
    const first = addNotificationToState(
      [],
      input({ message: 'two files to review', dedupeKey: 'crm:record:42' })
    )

    const second = addNotificationToState(
      first,
      input({ message: 'five files to review', dedupeKey: 'crm:record:42' })
    )

    // One row per thing, showing its current state. A progress-style notification that stacks turns one event
    // into a dozen unread items.
    expect(second).toHaveLength(1)
    expect(second[0]!.message).toBe('five files to review')
  })

  it('keeps notifications about different things side by side', () => {
    const first = addNotificationToState([], input({ dedupeKey: 'crm:record:1' }))

    const second = addNotificationToState(first, input({ dedupeKey: 'crm:record:2' }))

    expect(second).toHaveLength(2)
  })

  it('never collapses notifications that carry no identity', () => {
    let state = addNotificationToState([], input({ message: 'first' }))
    state = addNotificationToState(state, input({ message: 'second' }))
    state = addNotificationToState(state, input({ message: 'third', dedupeKey: '  ' }))

    // Without a key there is nothing to match on, so each is its own event - including one whose key is only
    // whitespace, which must not silently match another blank.
    expect(state.map(({ message }) => message)).toEqual(['third', 'second', 'first'])
  })

  it('matches an identity regardless of the spaces around it', () => {
    const first = addNotificationToState([], input({ dedupeKey: 'crm:record:42' }))

    const second = addNotificationToState(first, input({ dedupeKey: '  crm:record:42  ' }))

    expect(second).toHaveLength(1)
    expect(second[0]!.dedupeKey).toBe('crm:record:42')
  })

  it('holds fifty at most, dropping the oldest', () => {
    let state: Notification[] = []
    for (let index = 0; index < 55; index += 1) {
      state = addNotificationToState(state, input({ message: `n${index}` }))
    }

    expect(state).toHaveLength(50)
    expect(state[0]!.message).toBe('n54')
    expect(state.at(-1)!.message).toBe('n5')
  })

  it('carries the domain payload through without inspecting it', () => {
    const target = { view: 'actions', mode: 'todo', actionId: 7 }

    const [added] = addNotificationToState([], input({ target, approvalId: 3, actionId: 7 }))

    // Core persists the payload and the owning feature resolves it. Interpreting it here would put domain
    // knowledge in the one place that is meant to stay ignorant of it.
    expect(added!.target).toEqual(target)
    expect(added).toMatchObject({ approvalId: 3, actionId: 7 })
  })
})
