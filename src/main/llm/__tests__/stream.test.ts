/**
 * Integration test for the shared streaming transport. Drives streamCompletion
 * against a REAL local http server that emits OpenAI-style SSE chunks (the same
 * shape llama-server sends), so the buffered newline split, parseSseLine routing,
 * tool-call accumulation, abort, timeout, and non-200 paths are exercised for
 * real — not mocked. This covers logic that used to live (duplicated) inside the
 * coverage-excluded llm.ts.
 */
import { describe, it, expect, afterEach } from 'vitest'
import http from 'http'
import { streamCompletion } from '../stream'

let server: http.Server | null = null

/** Spin up a one-shot server whose /v1/chat/completions handler is `handler`. */
async function serve(handler: (res: http.ServerResponse) => void): Promise<number> {
  server = http.createServer((_req, res) => handler(res))
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  return (server!.address() as { port: number }).port
}

/** Format a delta object as an SSE `data:` line (llama-server style). */
const sse = (delta: unknown): string => `data: ${JSON.stringify({ choices: [{ delta }] })}\n`

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()))
    server = null
  }
})

describe('streamCompletion', () => {
  it('streams content deltas and resolves the full answer', async () => {
    const port = await serve((res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(sse({ content: 'Hello' }))
      res.write(sse({ content: ', world' }))
      res.write('data: [DONE]\n')
      res.end()
    })
    const seen: { text: string; kind: string }[] = []
    const out = await streamCompletion(port, '{}', (text, kind) => seen.push({ text, kind }), {
      timeoutMs: 5000
    })
    expect(out.content).toBe('Hello, world')
    expect(out.toolCalls).toEqual([])
    expect(out.finishReason).toBeNull()
    expect(seen).toEqual([
      { text: 'Hello', kind: 'content' },
      { text: ', world', kind: 'content' }
    ])
  })

  it('returns the native finish reason with the streamed answer', async () => {
    const port = await serve((res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(sse({ content: 'capped answer' }))
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n`)
      res.write('data: [DONE]\n')
      res.end()
    })

    await expect(
      streamCompletion(port, '{}', () => {}, { timeoutMs: 5000 })
    ).resolves.toMatchObject({
      content: 'capped answer',
      finishReason: 'length'
    })
  })

  it('routes reasoning_content to the reasoning channel, separate from the answer', async () => {
    const port = await serve((res) => {
      res.writeHead(200)
      res.write(sse({ reasoning_content: 'thinking...' }))
      res.write(sse({ content: 'answer' }))
      res.end()
    })
    const reasoning: string[] = []
    const content: string[] = []
    const out = await streamCompletion(
      port,
      '{}',
      (text, kind) => (kind === 'reasoning' ? reasoning : content).push(text),
      {
        timeoutMs: 5000
      }
    )
    expect(reasoning).toEqual(['thinking...'])
    expect(out.content).toBe('answer') // reasoning excluded from the answer
  })

  it('routes OpenRouter reasoning_details to the reasoning channel', async () => {
    const port = await serve((res) => {
      res.writeHead(200)
      res.write(
        sse({
          reasoning_details: [
            { type: 'reasoning.text', text: 'checking ' },
            { type: 'reasoning.summary', summary: 'done' }
          ]
        })
      )
      res.write(sse({ content: 'answer' }))
      res.end()
    })
    const reasoning: string[] = []
    const out = await streamCompletion(
      port,
      '{}',
      (text, kind) => {
        if (kind === 'reasoning') reasoning.push(text)
      },
      { timeoutMs: 5000 }
    )

    expect(reasoning).toEqual(['checking done'])
    expect(out.content).toBe('answer')
  })

  it('reassembles a delta split across TCP chunk boundaries', async () => {
    const port = await serve((res) => {
      res.writeHead(200)
      const line = sse({ content: 'spanning' })
      res.write(line.slice(0, 10)) // half a line...
      setTimeout(() => {
        res.write(line.slice(10)) // ...the rest arrives later
        res.end()
      }, 20)
    })
    const out = await streamCompletion(port, '{}', () => {}, { timeoutMs: 5000 })
    expect(out.content).toBe('spanning')
  })

  it('accumulates tool_calls and returns them', async () => {
    const port = await serve((res) => {
      res.writeHead(200)
      res.write(
        sse({
          tool_calls: [
            { index: 0, id: 'c1', function: { name: 'search_memory', arguments: '{"q":' } }
          ]
        })
      )
      res.write(sse({ tool_calls: [{ index: 0, function: { arguments: '"fox"}' } }] }))
      res.end()
    })
    const out = await streamCompletion(port, '{}', () => {}, { timeoutMs: 5000 })
    expect(out.toolCalls).toHaveLength(1)
    expect(out.toolCalls[0]!.name).toBe('search_memory')
    expect(out.toolCalls[0]!.arguments).toBe('{"q":"fox"}') // reassembled across deltas
  })

  it('rejects on a non-200 status', async () => {
    const port = await serve((res) => {
      res.writeHead(500)
      res.end('boom')
    })
    await expect(streamCompletion(port, '{}', () => {}, { timeoutMs: 5000 })).rejects.toThrow(
      /LLM Server Error: 500/
    )
  })

  it('rejects with a timeout when the server never responds in time', async () => {
    const port = await serve(() => {
      /* never write, never end */
    })
    await expect(streamCompletion(port, '{}', () => {}, { timeoutMs: 80 })).rejects.toThrow(
      /timed out/
    )
  })

  it('does NOT time out a long stream that keeps making progress (idle timeout, not total)', async () => {
    // Drip chunks for LONGER than timeoutMs, but with each gap SHORTER than it. A total-duration
    // timer would kill this mid-stream (the "LLM request timed out at ~5 min" bug once output was
    // uncapped); the idle timer re-arms on every chunk, so a healthy long stream completes.
    const parts = ['Hel', 'lo', ', ', 'wor', 'ld', '!']
    const port = await serve((res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      let i = 0
      const tick = (): void => {
        if (i < parts.length) {
          res.write(sse({ content: parts[i++] }))
          setTimeout(tick, 80) // gap (80ms) < timeoutMs; total drip (~480ms) > timeoutMs
        } else {
          res.write('data: [DONE]\n')
          res.end()
        }
      }
      tick()
    })
    const out = await streamCompletion(port, '{}', () => {}, { timeoutMs: 250 })
    expect(out.content).toBe('Hello, world!')
  })

  it('times out when the stream STALLS mid-response (no data for the idle window)', async () => {
    // First chunk arrives, then silence — the idle timer fires after timeoutMs of no progress.
    const port = await serve((res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(sse({ content: 'partial…' }))
      /* then nothing: never write again, never end */
    })
    await expect(streamCompletion(port, '{}', () => {}, { timeoutMs: 120 })).rejects.toThrow(
      /timed out/
    )
  })

  it('resolves with whatever streamed so far when the caller aborts mid-stream', async () => {
    const port = await serve((res) => {
      res.writeHead(200)
      res.write(sse({ content: 'partial' }))
      // keep the stream open so the abort (not end) resolves it
    })
    const ctrl = new AbortController()
    const p = streamCompletion(port, '{}', () => {}, { timeoutMs: 5000, signal: ctrl.signal })
    setTimeout(() => ctrl.abort(), 40)
    const out = await p
    expect(out.content).toBe('partial')
  })
})
