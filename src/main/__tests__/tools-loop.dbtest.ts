// Integration tests for the agentic tool loop — the REAL toolChat + REAL LLMService,
// over a real in-process fake llama-server socket and a real temp SQLite DB. The ONLY
// things faked are true external boundaries: the native engine (its tokens replayed as
// real SSE over http, see harness/fake-llama-server), Electron's userData dir, and the
// network (global fetch, for the web tools). No mock of our own code, no canned llm, no
// toHaveBeenCalled — the real streaming, real tool-call assembly, real dispatch/runTool,
// and the real built-in tools all execute. We assert terminal artifacts (the produced
// result, the streamed answer, r.imageRequest/r.unified, and what the model was sent).
import { describe, it, expect, afterAll, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { startFakeLlamaServer, type FakeLlamaServer } from './harness/fake-llama-server'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-tools-it-'))
vi.mock('electron', () => ({
  app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}))

// Imported AFTER the electron boundary is stubbed so their top-level app.getPath resolves.
import {
  toolChat,
  listTools,
  setToolEnabled,
  registerToolExtension,
  getToolExtensions,
  readUrlText
} from '../tools'
import { llm } from '../llm'

let fake: FakeLlamaServer

beforeAll(async () => {
  fake = await startFakeLlamaServer()
  // Point the REAL LLMService at the fake engine socket and mark it ready — init() then
  // no-ops (early-returns when initialized), so no native binary spawns. Every other line
  // of the service runs for real against the socket.
  const svc = llm as unknown as { port: number; initialized: boolean; paused: boolean }
  svc.port = fake.port
  svc.initialized = true
  svc.paused = false
})
beforeEach(() => fake.reset())
afterAll(async () => {
  await fake.close()
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

describe('agentic tool loop — real toolChat + real LLMService over a fake llama socket', () => {
  it('streams reasoning + content and returns the answer when no tool is called', async () => {
    fake.enqueue({ reasoning: 'Let me think', content: 'Hi there' })
    const deltas: { text: string; kind: string }[] = []
    const steps: string[] = []
    const r = await toolChat('hi', [], {
      onDelta: (t, k) => deltas.push({ text: t, kind: k }),
      onStep: (c) => steps.push(c.name)
    })

    expect(r.answer).toBe('Hi there')
    // Deltas arrive chunked (real streaming): the reasoning channel fired, and the content
    // deltas concatenate to the answer.
    expect(deltas.some((d) => d.kind === 'reasoning')).toBe(true)
    expect(
      deltas
        .filter((d) => d.kind === 'content')
        .map((d) => d.text)
        .join('')
    ).toBe('Hi there')
    expect(steps).toEqual([]) // no tool call -> no step
  })

  it('sends the user Max-output setting to the model, not the old hardcoded 1024 cap (essay cut-off)', async () => {
    // The agentic path used to force maxTokens: 1024, so a long "All memory" answer was truncated
    // mid-sentence at ~1024 tokens regardless of the setting/window. Now it inherits the setting.
    const svc = llm as unknown as { maxTokens: number }
    const prev = svc.maxTokens
    svc.maxTokens = 5000 // a distinctive user cap
    try {
      fake.enqueue({ content: 'a long answer' })
      await toolChat('write a lot', [])
      const round1 = fake.requests[0] as { max_tokens?: number }
      expect(round1.max_tokens).toBe(5000) // inherits the user's setting…
      expect(round1.max_tokens).not.toBe(1024) // …never the removed hardcap
    } finally {
      svc.maxTokens = prev
    }
  })

  it('defaults the tool-loop answer to auto — max_tokens = -1 (until EOS / window fills)', async () => {
    const svc = llm as unknown as { maxTokens: number }
    const prev = svc.maxTokens
    svc.maxTokens = 0 // MAX_TOKENS_AUTO
    try {
      fake.enqueue({ content: 'ok' })
      await toolChat('hi', [])
      expect((fake.requests[0] as { max_tokens?: number }).max_tokens).toBe(-1)
    } finally {
      svc.maxTokens = prev
    }
  })

  it('executes a tool call, fires onStep before running it, feeds the result back, then answers', async () => {
    fake.enqueue({ toolCalls: [{ name: 'get_datetime', args: {} }] }, { content: 'It is now.' })
    const steps: string[] = []
    const r = await toolChat('what time is it', [], { onStep: (c) => steps.push(c.name) })

    expect(steps).toEqual(['get_datetime']) // step surfaced BEFORE execution
    expect(r.toolCalls.map((c) => c.name)).toEqual(['get_datetime'])
    expect(r.toolCalls[0]!.result).toBeTruthy() // real get_datetime output
    expect(r.answer).toBe('It is now.')
    // The loop fed the result back: round-2 request carries the assistant tool_call turn + the tool result.
    const round2 = fake.requests[1] as { messages?: Array<{ role: string }> }
    expect(round2.messages?.some((m) => m.role === 'tool')).toBe(true)
    expect(round2.messages?.some((m) => m.role === 'assistant')).toBe(true)
  })

  it('passes the tool schemas + tool_choice to the model on the first round', async () => {
    fake.enqueue({ content: 'ok' })
    await toolChat('hi', [])
    const round1 = fake.requests[0] as { tools?: unknown[]; tool_choice?: string }
    expect(Array.isArray(round1.tools)).toBe(true)
    expect((round1.tools ?? []).length).toBeGreaterThan(0)
    expect(round1.tool_choice).toBe('auto')
  })

  it('stops after the max tool-step budget instead of looping forever', async () => {
    // Enqueue more tool-call rounds than the cap; the loop must bail, not spin.
    for (let i = 0; i < 8; i++) fake.enqueue({ toolCalls: [{ name: 'get_datetime', args: {} }] })
    const r = await toolChat('loop', [])
    expect(r.answer).toMatch(/too many tool steps/i)
    expect(fake.requests.length).toBeLessThanOrEqual(6)
  })

  it('runs the calculator the model asks for, feeds the real result back, and answers', async () => {
    fake.enqueue(
      { toolCalls: [{ name: 'calculator', args: { expression: '(3+4)*2' } }] },
      { content: 'The answer is 14.' }
    )
    const r = await toolChat('what is (3+4)*2', [])
    expect(r.toolCalls.map((c) => ({ name: c.name, result: c.result }))).toContainEqual({
      name: 'calculator',
      result: '14'
    })
    expect(r.answer).toContain('14')
    expect(JSON.stringify((fake.requests[1] as { messages?: unknown[] }).messages ?? [])).toContain(
      '14'
    )
  })

  it('recovers a tool call the model emitted as TEXT (no native tool_calls) and runs it', async () => {
    // The small on-device models we ship often print <tool_call>{…} as content
    // instead of using the tool_calls channel. The loop must recover it, run the
    // tool for real, feed the result back, and still answer — not narrate a dead
    // "I would calculate…". Round 1 has NO toolCalls, only text.
    fake.enqueue(
      {
        content:
          'Let me compute that.\n<tool_call>{"name":"calculator","arguments":{"expression":"2+2"}}</tool_call>'
      },
      { content: 'It is 4.' }
    )
    const steps: string[] = []
    const r = await toolChat('what is 2+2', [], { onStep: (c) => steps.push(c.name) })

    expect(steps).toEqual(['calculator']) // recovered from text + surfaced before running
    expect(r.toolCalls.map((c) => ({ name: c.name, result: c.result }))).toContainEqual({
      name: 'calculator',
      result: '4'
    })
    expect(r.answer).toContain('4')
    // The recovered call was fed back as a real tool turn on round 2.
    const round2 = fake.requests[1] as { messages?: Array<{ role: string }> }
    expect(round2.messages?.some((m) => m.role === 'tool')).toBe(true)
  })

  it('forces a real final answer from the results when the step cap is hit (no dead-end)', async () => {
    // Five tool-call rounds exhaust the loop; instead of a canned "stopped" reply,
    // the loop makes ONE more no-tools generation so the user gets a real answer
    // built from what the tools returned.
    for (let i = 0; i < 5; i++) {
      fake.enqueue({ toolCalls: [{ name: 'get_datetime', args: {} }] })
    }
    fake.enqueue({ content: 'Based on the tools, here is your answer.' })
    const r = await toolChat('keep going', [])
    expect(r.answer).toBe('Based on the tools, here is your answer.')
    expect(r.answer).not.toMatch(/too many tool steps/i)
    // The final generation ran WITHOUT tools (the forced answer pass).
    const lastReq = fake.requests[fake.requests.length - 1] as { tools?: unknown[] }
    expect(lastReq.tools ?? []).toHaveLength(0)
  })

  it('rejects a non-arithmetic calculator expression (real guard branch)', async () => {
    fake.enqueue(
      { toolCalls: [{ name: 'calculator', args: { expression: 'process.exit(1)' } }] },
      { content: 'Cannot compute that.' }
    )
    const r = await toolChat('evil', [])
    expect(r.toolCalls[0]!.result).toMatch(/only basic arithmetic/i)
  })

  it('tolerates malformed tool arguments (non-JSON args string)', async () => {
    // The engine can emit invalid JSON for arguments; the real accumulator/parse must not throw.
    fake.enqueue(
      { toolCalls: [{ name: 'get_datetime', argsRaw: 'not-json' }] },
      { content: 'done' }
    )
    const r = await toolChat('time', [])
    expect(r.toolCalls[0]!.name).toBe('get_datetime')
    expect(r.answer).toBe('done')
  })

  it('surfaces an actionable server error (context overflow) instead of a bare status', async () => {
    fake.enqueue({
      errorStatus: 400,
      errorBody: JSON.stringify({
        error: { message: 'the request exceeds the available context size' }
      })
    })
    await expect(toolChat('anything', [])).rejects.toThrow(/context window|connectors/i)
  })

  // --- generate_image (gated + deferred side-channel) ---------------------------
  it('offers generate_image only when an image model is available', async () => {
    fake.enqueue({ content: 'ok' })
    await toolChat('draw a cat', [], { imageAvailable: true })
    const withImg = fake.requests[0] as { tools: { function: { name: string } }[] }
    expect(withImg.tools.map((t) => t.function.name)).toContain('generate_image')

    fake.reset()
    fake.enqueue({ content: 'ok' })
    await toolChat('draw a cat', [], { imageAvailable: false })
    const withoutImg = fake.requests[0] as { tools: { function: { name: string } }[] }
    expect(withoutImg.tools.map((t) => t.function.name)).not.toContain('generate_image')
  })

  it('records the requested prompt as imageRequest, fires onStep, and still returns the answer', async () => {
    fake.enqueue(
      { toolCalls: [{ name: 'generate_image', args: { prompt: 'a red bicycle on a beach' } }] },
      { content: 'Here is your image.' }
    )
    const steps: string[] = []
    const r = await toolChat('make a picture of a red bicycle', [], {
      imageAvailable: true,
      onStep: (c) => steps.push(c.name)
    })
    expect(steps).toEqual(['generate_image'])
    expect(r.imageRequest).toEqual({ prompt: 'a red bicycle on a beach' })
    expect(r.toolCalls[0]!.result).toMatch(/will appear in the chat/i) // placeholder fed back
    expect(r.answer).toBe('Here is your image.')
  })

  it('keeps every generate_image request in tool-call order', async () => {
    fake.enqueue(
      {
        toolCalls: [
          { name: 'generate_image', args: { prompt: 'first' } },
          { name: 'generate_image', args: { prompt: 'second' } }
        ]
      },
      { content: 'done' }
    )
    const r = await toolChat('two pictures', [], { imageAvailable: true })
    expect(r.imageRequests).toEqual([{ prompt: 'first' }, { prompt: 'second' }])
  })

  it('does not record an imageRequest when the prompt is empty', async () => {
    fake.enqueue(
      { toolCalls: [{ name: 'generate_image', args: { prompt: '   ' } }] },
      { content: 'I could not tell what to draw.' }
    )
    const r = await toolChat('draw', [], { imageAvailable: true })
    expect(r.imageRequest).toBeUndefined()
    expect(r.toolCalls[0]!.result).toMatch(/no image prompt/i)
  })

  // --- connector/extension routing (a test-provided extension = the MCP boundary) ----
  it('routes a connector tool through the registered extension and returns its real result', async () => {
    registerToolExtension({
      id: 'test-ext',
      schemas: () => [
        {
          type: 'function',
          function: {
            name: 'ext_tool',
            description: 'x',
            parameters: { type: 'object', properties: {} }
          }
        }
      ],
      canHandle: (n) => n === 'ext_tool',
      execute: async () => 'ext-result',
      systemHint: () => 'Extra hint.'
    })
    expect(getToolExtensions().some((e) => e.id === 'test-ext')).toBe(true)
    fake.enqueue({ toolCalls: [{ name: 'ext_tool', args: {} }] }, { content: 'used the connector' })
    const r = await toolChat('do it', [], { connectors: true })
    // Terminal artifact: the extension actually ran and its result flowed back into the loop.
    expect(r.toolCalls[0]).toMatchObject({ name: 'ext_tool', result: 'ext-result' })
    expect(r.answer).toBe('used the connector')
  })

  // --- abort: a cancelled turn runs NO tool side effect (D15) --------------------
  it('a cancelled turn runs NO tool — Stop after the tool_call streams, before execution', async () => {
    let ran = false
    registerToolExtension({
      id: 'abort-ext',
      schemas: () => [
        {
          type: 'function',
          function: {
            name: 'abort_tool',
            description: 'x',
            parameters: { type: 'object', properties: {} }
          }
        }
      ],
      canHandle: (n) => n === 'abort_tool',
      execute: async () => {
        ran = true
        return 'should-never-run'
      },
      systemHint: () => ''
    })
    // The server streams the tool_call then HANGS; we hit Stop mid-turn — after the call
    // arrived but before runTool. The real abort guard must skip execution.
    fake.enqueue({ toolCalls: [{ name: 'abort_tool', args: {} }], hold: true })
    const ac = new AbortController()
    const p = toolChat('do the thing', [], { connectors: true, signal: ac.signal })
    await new Promise((r) => setTimeout(r, 60)) // let the tool_call frame stream + the server hang
    ac.abort()
    await p
    expect(ran).toBe(false) // the MCP write tool never fired after Stop
  })

  // --- DIP guard: the loop must not re-introduce per-tool-name branching ----------
  it('dispatches every tool uniformly — no c.name special-casing in the loop', () => {
    const src = fs.readFileSync(path.join(__dirname, '../tools.ts'), 'utf8')
    expect(src).not.toMatch(/c\.name === ['"]search_memory['"]/)
    expect(src).not.toMatch(/c\.name === ['"]generate_image['"]/)
  })
})

describe('tools registry surface (real settings DB)', () => {
  it('listTools reports every built-in as enabled by default; disabling one persists + reflects', () => {
    // Real getSetting/saveSetting against the temp DB — no mock.
    const all = listTools()
    expect(all.length).toBeGreaterThan(0)
    expect(all.map((t) => t.name)).toContain('calculator')
    expect(all.every((t) => t.enabled)).toBe(true)

    setToolEnabled('calculator', false)
    expect(listTools().find((t) => t.name === 'calculator')?.enabled).toBe(false)
    setToolEnabled('calculator', true) // restore for other tests
    expect(listTools().find((t) => t.name === 'calculator')?.enabled).toBe(true)
  })
})

describe('web tools — real parsers over fetch faked at the network boundary', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('readUrlText strips tags + decodes entities into readable text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        text: async () =>
          '<html><body><script>x()</script><h1>Title &amp; more</h1><p>Hello&nbsp;world</p></body></html>'
      }))
    )
    const text = await readUrlText('example.com') // no scheme -> https:// prepended
    expect(text).toContain('Title & more')
    expect(text).toContain('Hello world')
    expect(text).not.toContain('<h1>')
    expect(text).not.toContain('x()')
  })

  it('readUrlText throws on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, text: async () => '' }))
    )
    await expect(readUrlText('https://example.com')).rejects.toThrow(/HTTP 500/)
  })

  it('web_search parses DuckDuckGo result links + snippets through the real loop', async () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2FAchilles">Achilles - Wikipedia</a>
      <a class="result__snippet">A hero of the Trojan War.</a>`
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, text: async () => html }))
    )
    fake.enqueue(
      { toolCalls: [{ name: 'web_search', args: { query: 'achilles' } }] },
      { content: 'Here is what I found.' }
    )
    const r = await toolChat('search achilles', [])
    expect(r.toolCalls[0]!.result).toContain('en.wikipedia.org/Achilles')
    expect(r.toolCalls[0]!.result).toContain('Achilles - Wikipedia')
    expect(r.toolCalls[0]!.result).toContain('Trojan War')
  })

  it('does not leak <tool_call> markup into the visible content stream (still runs the tool)', async () => {
    // Round 1 emits the call as TEXT. The user must NOT see the raw <tool_call>{…}
    // flash in the answer stream, but the tool must still run and the turn answer.
    fake.enqueue(
      {
        content:
          'Let me compute. <tool_call>{"name":"calculator","arguments":{"expression":"6*7"}}</tool_call>'
      },
      { content: 'It is 42.' }
    )
    const contentDeltas: string[] = []
    const r = await toolChat('what is 6*7', [], {
      onDelta: (t, k) => {
        if (k === 'content') contentDeltas.push(t)
      }
    })
    const streamed = contentDeltas.join('')
    expect(streamed).not.toContain('<tool_call>') // markup filtered from the visible stream
    expect(streamed).not.toContain('calculator') // the JSON args never flashed either
    expect(r.toolCalls.map((c) => c.result)).toContain('42') // ...but the tool DID run
    expect(r.answer).toContain('42')
  })

  it('backfills the user query when the model calls web_search with an empty query', async () => {
    // A small model calls web_search with no query. The loop must backfill the
    // user's message so a real search runs instead of erroring on an empty query.
    let searchedUrl = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        searchedUrl = url
        return {
          ok: true,
          text: async () =>
            '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">Ex</a>'
        }
      })
    )
    fake.enqueue(
      { toolCalls: [{ name: 'web_search', args: {} }] }, // NO query
      { content: 'Found it.' }
    )
    const steps: { name: string; args: Record<string, unknown> }[] = []
    const r = await toolChat('tell me about achilles the hero', [], {
      onStep: (c) => steps.push(c)
    })

    // The user's message was backfilled as the query — surfaced in onStep AND sent to the network.
    expect(steps[0]!.args.query).toBe('tell me about achilles the hero')
    expect(decodeURIComponent(searchedUrl)).toContain('achilles the hero')
    expect(r.toolCalls[0]!.result).toContain('example.com')
  })
})
