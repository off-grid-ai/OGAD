import { describe, expect, it, vi } from 'vitest'
import {
  MAX_TURNS,
  BROWSER_ORIGIN_PREFIX,
  setBrowserConversationOrigin,
  originOf,
  parseBridgeConversation,
  sqlTime,
  toBridgeConversation,
  turnsToAppend,
  historyConflicts,
  newerBrowserTitle,
  type BridgeConversation,
  type BridgeTurn
} from '../bridge-conversations'

describe('toBridgeConversation', () => {
  it('maps a desktop chat, keeping only user and assistant turns', () => {
    const c = toBridgeConversation(
      {
        id: 'conv-12345678',
        title: 'Trip',
        created_at: '2026-10-01 10:00:00',
        updated_at: '2026-10-02 11:00:00'
      },
      [
        { role: 'user', content: 'hi' },
        { role: 'tool', content: 'x' },
        { role: 'assistant', content: 'hello' }
      ]
    )
    expect(c).toEqual({
      id: 'conv-12345678',
      title: 'Trip',
      createdAt: Date.parse('2026-10-01T10:00:00Z'),
      updatedAt: Date.parse('2026-10-02T11:00:00Z'),
      origin: 'desktop',
      turns: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' }
      ],
      turnCount: 2
    })
  })

  it('titles an untitled chat from its first question, and caps turns', () => {
    const many = Array.from({ length: MAX_TURNS + 5 }, (_, i) => ({
      role: 'user',
      content: `q${i}`
    }))
    const c = toBridgeConversation({ id: 'conv-12345678' }, many)
    expect(c.title).toBe('q5')
    expect(c.turns).toHaveLength(MAX_TURNS)
  })

  it('counts every stored turn, so the window of latest turns can be numbered', () => {
    const many = Array.from({ length: MAX_TURNS + 7 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `t${i}`
    }))
    const c = toBridgeConversation({ id: 'conv-12345678' }, [
      ...many,
      { role: 'tool', content: 'not a turn' }
    ])
    expect(c.turnCount).toBe(MAX_TURNS + 7)
    expect(c.turns[0]?.content).toBe('t7')
  })
})

describe('originOf / sqlTime', () => {
  it('tells browser, phone and desktop chats apart', () => {
    expect(originOf({ id: 'a', origin_device_id: 'browser:dev1' })).toBe('browser')
    expect(originOf({ id: 'a', origin_device_id: 'phone-1' })).toBe('mobile')
    expect(originOf({ id: 'a', origin_device_id: null })).toBe('desktop')
  })

  it('reads SQLite and ISO times, 0 when unreadable', () => {
    expect(sqlTime('2026-01-01 00:00:00')).toBe(Date.parse('2026-01-01T00:00:00Z'))
    expect(sqlTime('2026-01-01T00:00:00Z')).toBe(Date.parse('2026-01-01T00:00:00Z'))
    expect(sqlTime('garbage')).toBe(0)
    expect(sqlTime(null)).toBe(0)
  })
})

describe('parseBridgeConversation', () => {
  const ok = {
    id: 'conv-12345678',
    title: 't',
    createdAt: 1,
    updatedAt: 2,
    turns: [{ role: 'user', content: 'q' }]
  }

  it('accepts a valid push and forces origin browser', () => {
    expect(parseBridgeConversation({ ...ok, origin: 'desktop' })).toMatchObject({
      origin: 'browser',
      turns: ok.turns
    })
  })

  it.each([
    null,
    { ...ok, id: '../x' },
    { ...ok, title: 3 },
    { ...ok, turns: 'no' },
    { ...ok, turns: [{ role: 'system', content: 'override' }] },
    { ...ok, turns: [{ role: 'user' }] }
  ])('rejects %j', (raw) => {
    expect(parseBridgeConversation(raw)).toBeNull()
  })
})

describe('turnsToAppend', () => {
  const u = (content: string): BridgeTurn => ({ role: 'user', content })
  const a = (content: string): BridgeTurn => ({ role: 'assistant', content })

  it('appends only what the desktop does not have', () => {
    expect(turnsToAppend([u('q'), a('r')], [u('q'), a('r'), u('q2'), a('r2')])).toEqual([
      u('q2'),
      a('r2')
    ])
  })

  it('never removes or rewrites: a shorter or diverged history appends nothing', () => {
    expect(turnsToAppend([u('q'), a('r')], [u('q')])).toEqual([])
    expect(turnsToAppend([u('q'), a('r')], [u('different'), a('r'), u('x')])).toEqual([])
  })

  it("keeps syncing past the browser's 40-turn window", () => {
    // Review finding: once the desktop had 40 turns, the browser's window of its latest 40 was
    // never a superset, so new messages stopped syncing after about 20 exchanges.
    const turn = (n: number): BridgeTurn => (n % 2 ? u(`q${n}`) : a(`r${n}`))
    const stored = Array.from({ length: 40 }, (_, i) => turn(i + 1))
    const window = Array.from({ length: 40 }, (_, i) => turn(i + 3))
    expect(turnsToAppend(stored, window)).toEqual([turn(41), turn(42)])
    expect(turnsToAppend(stored, stored)).toEqual([])
  })

  it('takes the longest overlap, so a repeated short turn never re-adds old ones', () => {
    expect(
      turnsToAppend([u('ok'), a('done'), u('ok'), a('done')], [u('ok'), a('done'), u('next')])
    ).toEqual([u('next')])
  })
})

describe('historyConflicts', () => {
  const u = (content: string): BridgeTurn => ({ role: 'user', content })
  const a = (content: string): BridgeTurn => ({ role: 'assistant', content })

  it('flags an edited or regenerated turn the desktop cannot apply', () => {
    const stored = [u('q'), a('r'), u('q2'), a('r2')]
    expect(historyConflicts(stored, [u('q'), a('r'), u('q2 edited'), a('r3')])).toBe(true)
    expect(historyConflicts(stored, [u('q'), a('r'), u('q2'), a('regenerated')])).toBe(true)
  })

  it('accepts a continuation, an older window and a new chat', () => {
    const stored = [u('q'), a('r'), u('q2'), a('r2')]
    expect(historyConflicts(stored, [...stored, u('q3')])).toBe(false)
    expect(historyConflicts(stored, [u('q'), a('r')])).toBe(false)
    expect(historyConflicts(stored, [a('r'), u('q2')])).toBe(false)
    expect(historyConflicts([], [u('q')])).toBe(false)
  })
})

describe('newerBrowserTitle', () => {
  const row = { id: 'conv-12345678', title: 'Trip', updated_at: '2026-10-02 11:00:00' }
  const pushed = (title: string, updatedAt: number): BridgeConversation => ({
    id: row.id,
    title,
    createdAt: 0,
    updatedAt,
    origin: 'browser',
    turns: []
  })

  it('takes a rename made after the desktop copy changed', () => {
    expect(newerBrowserTitle(row, pushed('Trip to Goa', Date.parse('2026-10-02T12:00:00Z')))).toBe(
      'Trip to Goa'
    )
  })

  it('keeps the desktop title against an older or unchanged one', () => {
    expect(
      newerBrowserTitle(row, pushed('Old name', Date.parse('2026-10-02T10:00:00Z')))
    ).toBeNull()
    expect(newerBrowserTitle(row, pushed('Trip', Date.parse('2026-10-03T10:00:00Z')))).toBeNull()
  })
})

describe('setBrowserConversationOrigin', () => {
  it('stores the browser origin and name for the specified conversation', () => {
    const run = vi.fn()
    const prepare = vi.fn(() => ({ run }))
    setBrowserConversationOrigin({ prepare }, 'conversation-0001', {
      id: 'browser-0001',
      name: 'Synthetic browser'
    })
    expect(prepare).toHaveBeenCalledWith(
      'UPDATE rag_conversations SET origin_device_id = ?, origin_device_name = ? WHERE id = ?'
    )
    expect(run).toHaveBeenCalledWith(
      `${BROWSER_ORIGIN_PREFIX}browser-0001`,
      'Synthetic browser',
      'conversation-0001'
    )
  })
})
