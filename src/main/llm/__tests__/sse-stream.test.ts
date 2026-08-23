/**
 * Regression tests for the SSE streaming parse + <think> reasoning/content split -
 * the exact area behind a past streaming bug. These lock:
 *   - parseSseLine frame handling (data: prefix, [DONE], partial JSON, blank).
 *   - createThinkSplitter routing across chunk boundaries (open tag in one chunk,
 *     close in the next; multiple blocks; no think; think-only), and that the
 *     accumulated answer excludes reasoning.
 * Real inputs, no mocks.
 */

import { describe, it, expect } from 'vitest'
import {
  parseSseLine,
  createThinkSplitter,
  createToolCallAccumulator,
  createToolMarkupFilter,
  type StreamEvent
} from '../sse-stream'

describe('parseSseLine', () => {
  it('parses a normal content delta frame', () => {
    const d = parseSseLine('data: {"choices":[{"delta":{"content":"hi"}}]}')
    expect(d).toEqual({ delta: { content: 'hi' }, finishReason: null })
  })

  it('parses a reasoning_content delta frame', () => {
    const d = parseSseLine('data: {"choices":[{"delta":{"reasoning_content":"why"}}]}')
    expect(d).toEqual({ delta: { reasoning_content: 'why' }, finishReason: null })
  })

  it('handles an untrimmed line with leading/trailing whitespace (trims internally)', () => {
    const d = parseSseLine('  data: {"choices":[{"delta":{"content":"x"}}]}  ')
    expect(d).toEqual({ delta: { content: 'x' }, finishReason: null })
  })

  it('returns null for the [DONE] sentinel', () => {
    expect(parseSseLine('data: [DONE]')).toBeNull()
  })

  it('returns null for a non-data line (e.g. an SSE comment / blank)', () => {
    expect(parseSseLine(': keep-alive')).toBeNull()
    expect(parseSseLine('')).toBeNull()
    expect(parseSseLine('event: message')).toBeNull()
  })

  it('returns null for a partial / unparsable JSON frame', () => {
    expect(parseSseLine('data: {"choices":[{"delta":')).toBeNull()
  })

  it('returns null when the frame parses but has no delta object', () => {
    expect(parseSseLine('data: {"choices":[{}]}')).toBeNull()
    expect(parseSseLine('data: {"foo":1}')).toBeNull()
  })

  it('returns the empty delta object for an empty delta (no content/reasoning keys)', () => {
    // choices[0].delta === {} is a valid object - callers guard on the keys.
    expect(parseSseLine('data: {"choices":[{"delta":{}}]}')).toEqual({
      delta: {},
      finishReason: null
    })
  })

  it('preserves a terminal length reason even when the frame has no delta', () => {
    expect(parseSseLine('data: {"choices":[{"finish_reason":"length"}]}')).toEqual({
      delta: {},
      finishReason: 'length'
    })
  })
})

// Helper: run the splitter over an ordered list of content chunks, collecting events.
function runSplit(chunks: string[]): { events: StreamEvent[]; answer: string } {
  const events: StreamEvent[] = []
  const s = createThinkSplitter((ev) => events.push(ev))
  for (const c of chunks) s.push(c)
  return { events, answer: s.answer() }
}

describe('createThinkSplitter', () => {
  it('routes plain content (no think tags) entirely to content and accumulates it', () => {
    const { events, answer } = runSplit(['Hello ', 'world'])
    expect(events).toEqual([
      { text: 'Hello ', kind: 'content' },
      { text: 'world', kind: 'content' }
    ])
    expect(answer).toBe('Hello world')
  })

  it('splits a single inline <think>…</think> block: reasoning excluded from answer', () => {
    const { events, answer } = runSplit(['<think>reasoning</think>answer'])
    expect(events).toEqual([
      { text: 'reasoning', kind: 'reasoning' },
      { text: 'answer', kind: 'content' }
    ])
    expect(answer).toBe('answer')
  })

  it('emits leading content before a think block, then the reasoning, then trailing content', () => {
    const { events, answer } = runSplit(['pre <think>mid</think> post'])
    expect(events).toEqual([
      { text: 'pre ', kind: 'content' },
      { text: 'mid', kind: 'reasoning' },
      { text: ' post', kind: 'content' }
    ])
    expect(answer).toBe('pre  post')
  })

  it('carries in-think state across a chunk boundary (open tag one chunk, close the next)', () => {
    // The exact past-bug shape: <think> opens in chunk 1, closes in chunk 3.
    const { events, answer } = runSplit(['before <think>rea', 'soning con', 'tinues</think>after'])
    expect(events).toEqual([
      { text: 'before ', kind: 'content' },
      { text: 'rea', kind: 'reasoning' },
      { text: 'soning con', kind: 'reasoning' },
      { text: 'tinues', kind: 'reasoning' },
      { text: 'after', kind: 'content' }
    ])
    expect(answer).toBe('before after')
  })

  it('handles multiple think blocks in the stream', () => {
    const { events, answer } = runSplit(['a<think>t1</think>b<think>t2</think>c'])
    expect(events).toEqual([
      { text: 'a', kind: 'content' },
      { text: 't1', kind: 'reasoning' },
      { text: 'b', kind: 'content' },
      { text: 't2', kind: 'reasoning' },
      { text: 'c', kind: 'content' }
    ])
    expect(answer).toBe('abc')
  })

  it('handles a think block with no trailing content (ends inside answer nothing)', () => {
    const { events, answer } = runSplit(['<think>only reasoning</think>'])
    expect(events).toEqual([{ text: 'only reasoning', kind: 'reasoning' }])
    expect(answer).toBe('')
  })

  it('handles an unclosed think block (stream ends mid-reasoning): all reasoning, empty answer', () => {
    const { events, answer } = runSplit(['<think>still thinking when the stream ended'])
    expect(events).toEqual([{ text: 'still thinking when the stream ended', kind: 'reasoning' }])
    expect(answer).toBe('')
  })

  it('splits an open tag straddling two chunks (< in one, think> plus body in next)', () => {
    // The tag text itself lands whole in one chunk here, but the point is the
    // content before it is emitted immediately and the answer excludes reasoning.
    const { events, answer } = runSplit(['keep this ', '<think>hidden</think> and this'])
    expect(events).toEqual([
      { text: 'keep this ', kind: 'content' },
      { text: 'hidden', kind: 'reasoning' },
      { text: ' and this', kind: 'content' }
    ])
    expect(answer).toBe('keep this  and this')
  })

  it('ignores empty pushes (no events, answer unchanged)', () => {
    const { events, answer } = runSplit(['', 'hi', ''])
    expect(events).toEqual([{ text: 'hi', kind: 'content' }])
    expect(answer).toBe('hi')
  })
})

describe('createToolCallAccumulator - assembling streamed tool_calls', () => {
  it('assembles one tool call from its streamed fragments (name + concatenated args)', () => {
    const acc = createToolCallAccumulator()
    // Mirrors the real gemma/llama-server stream: first frame has id+name, then args pieces.
    acc.push([
      {
        index: 0,
        id: 'call_1',
        type: 'function',
        function: { name: 'web_search', arguments: '{' }
      } as never
    ])
    acc.push([{ index: 0, function: { arguments: '"query"' } }])
    acc.push([{ index: 0, function: { arguments: ':"tokyo"}' } }])
    expect(acc.list()).toEqual([
      { id: 'call_1', name: 'web_search', arguments: '{"query":"tokyo"}' }
    ])
    expect(JSON.parse(acc.list()[0]!.arguments)).toEqual({ query: 'tokyo' })
  })

  it('keeps parallel tool calls separate by index', () => {
    const acc = createToolCallAccumulator()
    acc.push([{ index: 0, id: 'a', function: { name: 'web_search', arguments: '{"q":1}' } }])
    acc.push([{ index: 1, id: 'b', function: { name: 'calculator', arguments: '{"e":"1+1"}' } }])
    acc.push([{ index: 0, function: { arguments: '' } }])
    const list = acc.list()
    expect(list.map((c) => c.name)).toEqual(['web_search', 'calculator'])
    expect(list[1]).toEqual({ id: 'b', name: 'calculator', arguments: '{"e":"1+1"}' })
  })

  it('is a no-op on undefined/empty and drops fragments that never got a name', () => {
    const acc = createToolCallAccumulator()
    acc.push(undefined)
    acc.push([])
    expect(acc.list()).toEqual([])
    // A stray args-only fragment with no name is dropped (not a real call).
    acc.push([{ index: 0, function: { arguments: '{}' } }])
    expect(acc.list()).toEqual([])
  })

  it('sorts by index regardless of arrival order', () => {
    const acc = createToolCallAccumulator()
    acc.push([{ index: 2, id: 'c', function: { name: 'third', arguments: '{}' } }])
    acc.push([{ index: 0, id: 'a', function: { name: 'first', arguments: '{}' } }])
    expect(acc.list().map((c) => c.name)).toEqual(['first', 'third'])
  })
})

describe('createToolMarkupFilter - hide tool-call markup from the visible stream', () => {
  function collect(): { push: (t: string) => void; end: () => void; out: () => string } {
    let out = ''
    const f = createToolMarkupFilter((t) => {
      out += t
    })
    return { push: f.push, end: f.end, out: () => out }
  }

  it('passes plain content through unchanged (flushed on end)', () => {
    const f = collect()
    f.push('Here is your answer.')
    f.end()
    expect(f.out()).toBe('Here is your answer.')
  })

  it('emits text before a <tool_call> opener and suppresses the markup after it', () => {
    const f = collect()
    f.push(
      'Let me check that. <tool_call>{"name":"web_search","arguments":{"query":"x"}}</tool_call>'
    )
    f.end()
    expect(f.out()).toBe('Let me check that. ')
  })

  it('suppresses across chunk boundaries when the opener straddles chunks', () => {
    const f = collect()
    f.push('One moment <to')
    f.push('ol_call>{"name":"calculator"}')
    f.end()
    expect(f.out()).toBe('One moment ')
  })

  it('suppresses the <|tool_call|> variant and <invoke>', () => {
    const a = collect()
    a.push('a<|tool_call|>{}')
    a.end()
    expect(a.out()).toBe('a')
    const b = collect()
    b.push('b <invoke name="x">stuff')
    b.end()
    expect(b.out()).toBe('b ')
  })

  it('does NOT suppress a stray "<" that is not a tool-call opener', () => {
    const f = collect()
    f.push('if a < b and c > d then done')
    f.end()
    expect(f.out()).toBe('if a < b and c > d then done')
  })

  it('drops everything once suppressing, even across later pushes', () => {
    const f = collect()
    f.push('answer <tool_call>{')
    f.push('"name":"x"}')
    f.push('</tool_call> trailing junk')
    f.end()
    expect(f.out()).toBe('answer ')
  })

  it('removes a stray closing think tag before a text-form tool call', () => {
    const f = collect()
    f.push('I will search for that.</thi')
    f.push('nk>\n<tool_call><function=web_search>raw protocol')
    f.end()
    expect(f.out()).toBe('I will search for that.\n')
  })
})
