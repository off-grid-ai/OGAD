import { describe, expect, it } from 'vitest'
import {
  MAX_BRANCH_FROM,
  MAX_HISTORY_TURNS,
  MAX_TURN_CHARS,
  MAX_PROMPT_CHARS,
  MAX_PAGE_TEXT_CHARS,
  parseChatRead,
  parseChatStart
} from '../bridge-chat'

const identity = { runId: 'run-00000001', conversationId: 'chat-0000001' }
const start = { ...identity, prompt: 'Summarize this page', mode: 'chat' }

describe('browser chat request limits', () => {
  it('accepts a prompt at the limit without trimming or truncating it', () => {
    const prompt = ' ' + 'x'.repeat(MAX_PROMPT_CHARS - 2) + ' '
    expect(parseChatStart({ ...start, prompt })?.prompt).toBe(prompt)
    expect(parseChatStart({ ...start, prompt: prompt + 'x' })).toBeNull()
  })

  it.each(['', ' ', '\t\n', null, 1])('rejects a blank or non-string prompt %j', (prompt) => {
    expect(parseChatStart({ ...start, prompt })).toBeNull()
  })

  it('accepts history at the turn count limit and rejects one extra turn', () => {
    const history = Array.from({ length: MAX_HISTORY_TURNS }, () => ({
      role: 'user',
      content: 'x'
    }))
    expect(parseChatStart({ ...start, history })?.history).toEqual(history)
    expect(parseChatStart({ ...start, history: [...history, history[0]] })).toBeNull()
  })

  it('accepts turn text at the limit and rejects one extra character', () => {
    const turn = { role: 'assistant', content: 'x'.repeat(MAX_TURN_CHARS) }
    expect(parseChatStart({ ...start, history: [turn] })?.history).toEqual([turn])
    expect(
      parseChatStart({ ...start, history: [{ ...turn, content: turn.content + 'x' }] })
    ).toBeNull()
  })

  it.each([0, 12, MAX_BRANCH_FROM])('accepts stored turn index %i', (branchFrom) => {
    expect(parseChatStart({ ...start, branchFrom })?.branchFrom).toBe(branchFrom)
  })

  it.each([-1, 1.5, '2', NaN, Infinity, MAX_BRANCH_FROM + 1, Number.MAX_SAFE_INTEGER + 1, null])(
    'rejects invalid stored turn index %s',
    (branchFrom) => {
      expect(parseChatStart({ ...start, branchFrom })).toBeNull()
    }
  )

  it('leaves an absent stored turn index undefined', () => {
    expect(parseChatStart(start)?.branchFrom).toBeUndefined()
  })
  it('retains the branch, selected history, page, image, and source tab', () => {
    const input = {
      ...start,
      branch: true,
      history: [{ role: 'assistant', content: 'Selected earlier answer' }],
      pageText: 'Page content',
      imageDataUrl: 'data:image/png;base64,aGVsbG8=',
      tabId: 0
    }
    expect(parseChatStart(input)).toEqual(input)
  })

  it.each([
    null,
    [],
    { ...start, runId: '../invalid' },
    { ...start, prompt: ' ' },
    { ...start, prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1) },
    { ...start, mode: 'unknown' },
    { ...start, history: {} },
    {
      ...start,
      history: Array.from({ length: MAX_HISTORY_TURNS + 1 }, () => ({ role: 'user', content: 'x' }))
    },
    { ...start, history: [{ role: 'system', content: 'Untrusted instruction' }] },
    { ...start, history: [{ role: 'user', content: 'x'.repeat(MAX_TURN_CHARS + 1) }] },
    { ...start, pageText: 'x'.repeat(100_001) },
    { ...start, tabId: -1 },
    { ...start, tabId: 1.5 },
    { ...start, imageDataUrl: 'https://example.test/private-image.png' },
    { ...start, imageDataUrl: 'data:image/svg+xml;base64,aGVsbG8=' },
    { ...start, imageDataUrl: 'data:image/png;base64,' + 'a'.repeat(2_500_000) }
  ])('rejects invalid or oversized input %#', (input) => {
    expect(parseChatStart(input)).toBeNull()
  })

  it('rejects a combined request that exceeds the encrypted transport budget', () => {
    const history = Array.from({ length: 150 }, () => ({
      role: 'user',
      content: 'x'.repeat(MAX_TURN_CHARS)
    }))
    expect(parseChatStart({ ...start, history })).toBeNull()
  })
})

describe('browser chat read contract', () => {
  const snapshot = {
    ...identity,
    cursor: 2,
    done: false,
    events: [{ type: 'token', text: 'Hello' }]
  }

  it('accepts an optional prompt at the limit and rejects one extra character', () => {
    const prompt = 'x'.repeat(MAX_PROMPT_CHARS)
    expect(parseChatRead({ ...snapshot, prompt })?.prompt).toBe(prompt)
    expect(parseChatRead({ ...snapshot, prompt: prompt + 'x' })).toBeNull()
    expect(parseChatRead({ ...snapshot, prompt: '' })?.prompt).toBe('')
  })

  it('retains events and the context needed to resume a closed panel', () => {
    const input = {
      ...snapshot,
      prompt: 'Earlier question',
      history: [{ role: 'user', content: 'Earlier context' }],
      tabId: 17
    }
    expect(parseChatRead(input)).toEqual(input)
    expect(parseChatRead({ ...snapshot, cursor: 0, done: true, events: [] })).toEqual({
      ...snapshot,
      cursor: 0,
      done: true,
      events: []
    })
  })

  it.each([
    null,
    { ...snapshot, conversationId: 'bad' },
    { ...snapshot, cursor: -1 },
    { ...snapshot, cursor: 0.5 },
    { ...snapshot, done: 'yes' },
    { ...snapshot, events: {} },
    { ...snapshot, history: [{ role: 'tool', content: 'x' }] },
    { ...snapshot, prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1) },
    { ...snapshot, tabId: -1 }
  ])('rejects an invalid response before it reaches the browser %#', (input) => {
    expect(parseChatRead(input)).toBeNull()
  })
})

describe('structured browser page', () => {
  const page = { title: 'Example', url: 'https://example.test/path', text: 'Page text' }

  it.each(['http:', 'https:'])('accepts and returns a valid %s page', (protocol) => {
    const input = { ...page, url: `${protocol}//example.test/path` }
    expect(parseChatStart({ ...start, page: input })?.page).toEqual(input)
  })

  it('accepts empty titles and fields at their length limits', () => {
    expect(parseChatStart({ ...start, page: { ...page, title: '' } })?.page?.title).toBe('')
    const input = {
      title: 't'.repeat(500),
      url: 'https://example.test/' + 'u'.repeat(2000 - 'https://example.test/'.length),
      text: 'x'.repeat(MAX_PAGE_TEXT_CHARS)
    }
    expect(input.url).toHaveLength(2000)
    expect(parseChatStart({ ...start, page: input })?.page).toEqual(input)
  })

  it.each([
    'javascript:alert(1)',
    'file:///tmp/page',
    'data:text/plain,hello',
    'chrome://settings',
    'not a URL',
    'https://'
  ])('rejects unsupported or invalid URL %j', (url) => {
    expect(parseChatStart({ ...start, page: { ...page, url } })).toBeNull()
  })

  it.each([
    { ...page, title: 't'.repeat(501) },
    { ...page, url: 'https://example.test/' + 'u'.repeat(2001 - 'https://example.test/'.length) },
    { ...page, text: 'x'.repeat(MAX_PAGE_TEXT_CHARS + 1) },
    ...['title', 'url', 'text'].flatMap((field) =>
      [null, 1, {}, [], undefined].map((value) => ({ ...page, [field]: value }))
    ),
    { ...page, extra: 'unexpected' },
    { title: page.title, url: page.url },
    Object.assign(Object.create({ inherited: true }), page),
    Object.assign(new Date(), page),
    Object.assign({ ...page }, { [Symbol('extra')]: 'unexpected' }),
    null,
    [],
    'page'
  ])('rejects malformed page %#', (input) => {
    expect(parseChatStart({ ...start, page: input })).toBeNull()
  })

  it('keeps old pageText unchanged and enforces the same wire cap', () => {
    const pageText = 'Title: Old\nURL: https://example.test/\n' + 'x'.repeat(100)
    expect(parseChatStart({ ...start, pageText })?.pageText).toBe(pageText)
    expect(parseChatStart({ ...start, pageText })?.page).toBeUndefined()
    expect(
      parseChatStart({ ...start, pageText: 'x'.repeat(MAX_PAGE_TEXT_CHARS) })?.pageText
    ).toHaveLength(MAX_PAGE_TEXT_CHARS)
    expect(parseChatStart({ ...start, pageText: 'x'.repeat(MAX_PAGE_TEXT_CHARS + 1) })).toBeNull()
  })

  it('returns both page formats when both are provided', () => {
    expect(parseChatStart({ ...start, page, pageText: 'Legacy' })).toMatchObject({
      page,
      pageText: 'Legacy'
    })
  })
})
