import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-search-'))
const previousDirectory = process.env.OFFGRID_DATA_DIR
process.env.OFFGRID_DATA_DIR = directory
vi.mock('electron', () => ({
  app: { getPath: () => directory, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}))
import { addRagMessage, createRagConversation, getDB } from '../database'
import { plainConversationPage } from '../extension-bridge/bridge-conversation-pages'
import { parseConversationParams } from '../extension-bridge/bridge-conversations'

beforeAll(() => {
  for (let i = 0; i < 1055; i++) {
    const id = `conversation-${String(i).padStart(4, '0')}`
    createRagConversation(id, i === 0 ? 'titleonly' : `Chat ${i}`)
    addRagMessage(id, 'user', i === 0 ? 'Old rareword' : 'commonword')
    getDB()
      .prepare('UPDATE rag_conversations SET updated_at = ?, origin_device_id = ? WHERE id = ?')
      .run(
        i === 0 ? '2020-01-01 00:00:00' : '2026-01-01 00:00:00',
        i % 3 === 0 ? 'browser:other' : i % 3 === 1 ? 'mobile-device' : null,
        id
      )
  }
  createRagConversation('markup-chat', 'Formatting')
  addRagMessage(
    'markup-chat',
    'assistant',
    '<b>**markupneedle**</b> [link](https://example.com) ' + 'word '.repeat(100)
  )
})
afterAll(() => {
  getDB().close()
  if (previousDirectory === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDirectory
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('bridge saved chat pages, real SQLite', () => {
  it('finds old message and title matches outside the recent list page', () => {
    const recent = plainConversationPage({ limit: 100 })
    expect(recent.conversations.map((c) => c.id)).not.toContain('conversation-0000')
    for (const query of ['rareword', 'titleonly']) {
      const found = plainConversationPage({ query })
      expect(found.conversations).toMatchObject([{ id: 'conversation-0000', origin: 'browser' }])
    }
  })
  it('uses default 30 and maximum 50, with complete paging beyond the Desktop ID helper cap', () => {
    expect(plainConversationPage({ query: 'commonword' }).conversations).toHaveLength(30)
    const ids: string[] = []
    let cursor: string | undefined
    do {
      const page = plainConversationPage({ query: 'commonword', limit: 50, cursor })
      expect(page.conversations.length).toBeLessThanOrEqual(50)
      ids.push(...page.conversations.map((c) => c.id))
      cursor = page.nextCursor
    } while (cursor)
    expect(ids).toHaveLength(1054)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual([...ids].sort().reverse())
  })
  it('lists all origins and does not skip tied timestamps across cursor pages', () => {
    const first = plainConversationPage({ limit: 50 })
    const second = plainConversationPage({ limit: 50, cursor: first.nextCursor })
    expect(first.nextCursor).toBeTypeOf('string')
    expect(first.conversations).toHaveLength(50)
    expect(second.conversations).toHaveLength(50)
    expect(new Set([...first.conversations, ...second.conversations].map((c) => c.id)).size).toBe(
      100
    )
    expect(new Set(first.conversations.map((c) => c.origin))).toEqual(
      new Set(['browser', 'mobile', 'desktop'])
    )
  })
  it('does not interpret punctuation as FTS syntax', () => {
    expect(() =>
      plainConversationPage({ query: '"foo" AND (bar* OR -baz) NEAR/3 :^' })
    ).not.toThrow()
    expect(plainConversationPage({ query: ':^()' }).conversations).toEqual([])
  })
  it('returns only summary fields with plain excerpts of at most 200 characters', () => {
    const page = plainConversationPage({ query: 'markupneedle' })
    expect(page.conversations[0]).toMatchObject({
      id: 'markup-chat',
      title: 'Formatting',
      origin: 'desktop',
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
      turnCount: 1
    })
    const hit = page.conversations[0]!
    expect(hit).not.toHaveProperty('turns')
    expect(Object.keys(hit).sort()).toEqual(
      ['id', 'title', 'createdAt', 'updatedAt', 'origin', 'snippet', 'turnCount'].sort()
    )
    const snippet = hit.snippet
    expect(snippet).toContain('markupneedle')
    expect(snippet.length).toBeLessThanOrEqual(200)
    expect(snippet).not.toMatch(/[<>*`[\]]|https:/)
  })
  it('keeps a search response small for a conversation with over 1 MB of turns', () => {
    const id = 'large-search-chat'
    createRagConversation(id, 'Large chat')
    const content = 'largechatneedle ' + 'word '.repeat(4000)
    const turns = 60
    expect(Buffer.byteLength(content) * turns).toBeGreaterThan(1024 * 1024)
    getDB().transaction(() => {
      for (let i = 0; i < turns; i++) {
        addRagMessage(id, i % 2 === 0 ? 'user' : 'assistant', content)
      }
      const internal = addRagMessage(id, 'assistant', 'Internal instruction')
      getDB().prepare("UPDATE rag_messages SET role = 'system' WHERE id = ?").run(internal.id)
    })()
    const page = plainConversationPage({ query: 'largechatneedle' })
    expect(page.conversations).toHaveLength(1)
    const hit = page.conversations[0]!
    expect(hit.turnCount).toBe(turns)
    expect(hit).not.toHaveProperty('turns')
    expect(Object.keys(hit).sort()).toEqual(
      ['id', 'title', 'createdAt', 'updatedAt', 'origin', 'snippet', 'turnCount'].sort()
    )
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(10_000)
    // Listing retains its existing turn window and content limits.
    const listed = plainConversationPage({ limit: 1 }).conversations[0]!
    expect(listed.id).toBe(id)
    expect(listed.turns).toHaveLength(40)
    expect(listed.turns[0]!.content).toHaveLength(20_000)
    expect(listed).not.toHaveProperty('snippet')
    // Every stored turn is counted, so the browser can number the window it got.
    expect(listed.turnCount).toBe(turns)
  })
  it('keeps the existing title fallback from the most recent 40 turns', () => {
    const id = 'untitled-search-chat'
    createRagConversation(id, 'temporary')
    getDB().transaction(() => {
      for (let i = 0; i < 45; i++) addRagMessage(id, 'user', `fallbackneedle turn ${i}`)
    })()
    getDB().prepare('UPDATE rag_conversations SET title = NULL WHERE id = ?').run(id)
    const hit = plainConversationPage({ query: 'fallbackneedle' }).conversations[0]!
    expect(hit.title).toBe('fallbackneedle turn 5')
    expect(hit.turnCount).toBe(45)
  })
  it('rejects empty queries and malformed or mismatched cursors', () => {
    for (const query of ['', '   '])
      expect(() => parseConversationParams({ query }, true)).toThrow('invalid')
    expect(() => plainConversationPage({ query: 'commonword', cursor: 'bad' })).toThrow('invalid')
    const page = plainConversationPage({ query: 'commonword', limit: 1 })
    expect(() => plainConversationPage({ query: 'rareword', cursor: page.nextCursor })).toThrow(
      'invalid'
    )
    expect(() => plainConversationPage({ cursor: page.nextCursor })).toThrow('invalid')
  })
})
