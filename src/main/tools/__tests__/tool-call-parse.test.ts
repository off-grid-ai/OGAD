/**
 * The text-format tool-call fallback parser. Guards the on-device robustness fix:
 * the small models we ship (gemma-4, qwen) often emit a tool call as TEXT instead
 * of on the native tool_calls channel; without recovery those turns produce no
 * call. Each case is a real shape a local model emits. Plain prose must yield [].
 */
import { describe, it, expect } from 'vitest'
import { parseToolCallsFromText, stripQwenToolCallMarkup } from '../tool-call-parse'

describe('parseToolCallsFromText', () => {
  it('recovers Qwen tool-call wrappers with JSON and named bodies', () => {
    expect(parseToolCallsFromText('<|tool_call_start|>{"name":"web_search","arguments":{"query":"weather"}}<|tool_call_end|>'))
      .toEqual([{ name: 'web_search', args: { query: 'weather' } }])
    expect(parseToolCallsFromText('<|tool_call_start|>web_search({"query":"weather"})<|tool_call_end|>'))
      .toEqual([{ name: 'web_search', args: { query: 'weather' } }])
  })

  it('removes Qwen tool-call wrappers from user-facing answer text', () => {
    expect(stripQwenToolCallMarkup('Checking. <|tool_call_start|>web_search({"query":"x"})<|tool_call_end|> Done.'))
      .toBe('Checking.  Done.')
  })
  it('parses a <tool_call> block (qwen/hermes style)', () => {
    const out = parseToolCallsFromText(
      'Let me look that up.\n<tool_call>\n{"name": "web_search", "arguments": {"query": "tok/s gemma"}}\n</tool_call>'
    )
    expect(out).toEqual([{ name: 'web_search', args: { query: 'tok/s gemma' } }])
  })

  it('parses a fenced ```json block', () => {
    const out = parseToolCallsFromText(
      'Sure:\n```json\n{"name":"calculator","arguments":{"expression":"(3+4)*2"}}\n```'
    )
    expect(out).toEqual([{ name: 'calculator', args: { expression: '(3+4)*2' } }])
  })

  it('parses a bare {name,arguments} object with no markup', () => {
    const out = parseToolCallsFromText(
      '{"name": "read_url", "arguments": {"url": "https://x.com"}}'
    )
    expect(out).toEqual([{ name: 'read_url', args: { url: 'https://x.com' } }])
  })

  it('accepts "parameters" as the args key, and a JSON-string args value', () => {
    const out = parseToolCallsFromText(
      '<tool_call>{"name":"web_search","parameters":"{\\"query\\":\\"x\\"}"}</tool_call>'
    )
    expect(out).toEqual([{ name: 'web_search', args: { query: 'x' } }])
  })

  it('unwraps an OpenAI-shaped {function:{name,arguments}} emitted as text', () => {
    const out = parseToolCallsFromText(
      '{"function": {"name": "calculator", "arguments": {"expression": "2+2"}}}'
    )
    expect(out).toEqual([{ name: 'calculator', args: { expression: '2+2' } }])
  })

  it('tolerates curly quotes + trailing commas (lenient JSON)', () => {
    const out = parseToolCallsFromText(
      '<tool_call>{“name”: “calculator”, “arguments”: {“expression”: “2+2”,}}</tool_call>'
    )
    expect(out).toEqual([{ name: 'calculator', args: { expression: '2+2' } }])
  })

  it('closes an unclosed object at EOS (model hit the token cap mid-call)', () => {
    const out = parseToolCallsFromText(
      '<tool_call>{"name":"web_search","arguments":{"query":"hello"'
    )
    expect(out).toEqual([{ name: 'web_search', args: { query: 'hello' } }])
  })

  it('parses multiple tool_call blocks in one message', () => {
    const out = parseToolCallsFromText(
      '<tool_call>{"name":"web_search","arguments":{"query":"a"}}</tool_call>\n<tool_call>{"name":"read_url","arguments":{"url":"b"}}</tool_call>'
    )
    expect(out.map((c) => c.name)).toEqual(['web_search', 'read_url'])
  })

  it('returns [] for plain prose (no false positives)', () => {
    expect(parseToolCallsFromText('Here is the answer: 42. No tools needed.')).toEqual([])
    expect(parseToolCallsFromText('')).toEqual([])
  })

  it('returns [] for a JSON answer that is NOT a tool call (no args key)', () => {
    // A model that replies with structured data must not be mistaken for a call.
    expect(parseToolCallsFromText('{"name": "Dishit", "role": "engineer"}')).toEqual([])
  })
})
