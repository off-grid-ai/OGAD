// Behaviour-faithful fake of the bundled llama-server, at its REAL boundary: a live
// http.createServer on a loopback port speaking the OpenAI-compatible endpoints the
// LLMService actually calls (/health, /v1/models, streaming /v1/chat/completions).
// Integration tests run the REAL LLMService + REAL toolChat over this socket — the
// model's TOKENS are faked at the wire (the one true external boundary: the native
// engine process), everything above it is our real code. NOT a mock of our code.
//
// A "turn" is one queued response the server replays for the next chat request, as
// real SSE `data:` frames + `[DONE]`. Queue several to drive a multi-round tool loop
// (round 1 emits a tool_call, round 2 emits the final answer) exactly as llama-server
// would. Requests beyond the queue get an empty-content turn (loop terminator).
import * as http from 'http'
import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'net'

const FAKE_TEXT_MODEL_ID = 'unsloth/Qwen3.5-0.8B-GGUF'
const FAKE_TEXT_MODEL_FILE = 'Qwen3.5-0.8B-Q4_K_M.gguf'
const FAKE_TEXT_PROJECTOR_FILE = 'mmproj-Qwen3.5-0.8B-BF16.gguf'
const GGUF_VERSION = 3

/**
 * Bytes a real GGUF file starts with: the `GGUF` magic, the little-endian u32 format version,
 * then filler past the shared minimum size. The production artifact verifier (magic, version,
 * minimum bytes) runs for real over these and passes on its own terms; only the weights are fake.
 * `marker` fills the body so two artifacts can be told apart byte-for-byte after a transfer.
 */
export function validGguf(marker: number): Buffer {
  const version = Buffer.alloc(4)
  version.writeUInt32LE(GGUF_VERSION, 0)
  return Buffer.concat([Buffer.from('GGUF', 'ascii'), version, Buffer.alloc(2_048, marker)])
}

/**
 * Install the minimum durable model selection needed by the real shared inventory.
 * The socket remains the only inference fake; model discovery and routing stay real.
 */
export function installFakeActiveTextModel(
  profileDir: string,
  options: { projector?: boolean } = {}
): void {
  const modelsDir = path.join(profileDir, 'models')
  fs.mkdirSync(modelsDir, { recursive: true })
  // Real GGUF header bytes: the application's own integrity check must accept this file.
  fs.writeFileSync(path.join(modelsDir, FAKE_TEXT_MODEL_FILE), validGguf(1))
  // The vision projector is a file on disk: present, the selected model can read images; absent,
  // it cannot. Tests that exercise the vision guard choose which world they are in here.
  const projector = path.join(modelsDir, FAKE_TEXT_PROJECTOR_FILE)
  if (options.projector === false) fs.rmSync(projector, { force: true })
  else fs.writeFileSync(projector, validGguf(2))
  fs.writeFileSync(
    path.join(modelsDir, 'active-model.json'),
    JSON.stringify({
      id: FAKE_TEXT_MODEL_ID,
      primary: FAKE_TEXT_MODEL_FILE,
      mmproj: FAKE_TEXT_PROJECTOR_FILE
    })
  )
}

interface FakeToolCall {
  id?: string
  name: string
  /** Arguments object; serialized to the JSON string llama-server emits. */
  args?: unknown
  /** Raw arguments string, emitted verbatim — for exercising malformed (non-JSON) args. */
  argsRaw?: string
}
interface FakeTurn {
  /** Answer text streamed as content deltas (split into a few frames like the engine). */
  content?: string
  /** Exact token-shaped content deltas. Long-answer tests use this to prove that more than
   *  the old token cap crossed the native socket without approximating tokens from chars. */
  contentDeltas?: string[]
  /** OpenAI-compatible terminal reason emitted beside the final empty delta. */
  finishReason?: string
  /** Reasoning streamed on the reasoning_content channel before the answer. */
  reasoning?: string
  /** Tool calls emitted on this turn (the agentic loop then runs them and calls back). */
  toolCalls?: FakeToolCall[]
  /** Force a non-200 to exercise the error path (body is surfaced by describeServerError). */
  errorStatus?: number
  errorBody?: string
  /** Delay the native-engine response after the request is admitted. Lifecycle tests use
   *  this to exercise cancellation/drain ownership without replacing any Off Grid AI service. */
  delayMs?: number
  /** Stream the frames then HANG (never send [DONE] / close) — so a client abort fires
   *  mid-turn. The real engine's socket stays open until the client cancels; this lets a
   *  test hit Stop after a tool_call has streamed but before the turn completes. */
  hold?: boolean
}

export interface FakeLlamaServer {
  port: number
  /** Queue the turns the server will replay, in order, one per chat request. */
  enqueue(...turns: FakeTurn[]): void
  /** Clear any queued-but-unconsumed turns + the recorded requests — call between tests
   *  so a case that over-enqueues (e.g. the step-budget cap) can't leak into the next. */
  reset(): void
  /** The request bodies received, parsed — for asserting what the REAL llm actually sent. */
  readonly requests: Array<Record<string, unknown>>
  close(): Promise<void>
}

function sseFramesFor(turn: FakeTurn): string[] {
  const frames: string[] = []
  const delta = (d: Record<string, unknown>): string =>
    `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`
  if (turn.reasoning) {
    frames.push(delta({ reasoning_content: turn.reasoning }))
  }
  turn.toolCalls?.forEach((tc, i) => {
    const args = tc.argsRaw ?? JSON.stringify(tc.args ?? {})
    // index so multiple tool_calls in one turn accumulate as distinct calls, like the engine.
    frames.push(
      delta({
        tool_calls: [
          {
            index: i,
            id: tc.id ?? `call_${tc.name}_${i}`,
            type: 'function',
            function: { name: tc.name, arguments: args }
          }
        ]
      })
    )
  })
  // Split content into a couple of frames so the real splitter/accumulator is exercised
  // across chunk boundaries, like the engine's token-by-token stream.
  const text = turn.content ?? ''
  if (turn.contentDeltas) {
    frames.push(...turn.contentDeltas.map((content) => delta({ content })))
  } else if (text) {
    const mid = Math.ceil(text.length / 2)
    frames.push(delta({ content: text.slice(0, mid) }))
    frames.push(delta({ content: text.slice(mid) }))
  }
  if (turn.finishReason) {
    frames.push(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: turn.finishReason }] })}\n\n`
    )
  }
  frames.push('data: [DONE]\n\n')
  return frames
}

export async function startFakeLlamaServer(): Promise<FakeLlamaServer> {
  const queue: FakeTurn[] = []
  const requests: Array<Record<string, unknown>> = []

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(req.url === '/health' ? { status: 'ok' } : { data: [{ id: 'fake' }] }))
      return
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = ''
      req.on('data', (c) => {
        body += c
      })
      req.on('end', () => {
        let parsed: Record<string, unknown> = {}
        try {
          parsed = JSON.parse(body)
        } catch {
          /* keep {} */
        }
        requests.push(parsed)
        const turn = queue.shift() ?? { content: '' }
        if (turn.errorStatus) {
          res.writeHead(turn.errorStatus, { 'Content-Type': 'application/json' })
          res.end(turn.errorBody ?? JSON.stringify({ error: { message: 'fake error' } }))
          return
        }
        const respond = (): void => {
          // Non-streaming path (llm.chat / postCompletionOnce): return ONE OpenAI-shaped
          // completion. llm.chat reads data.choices[0].message.content.
          if (parsed.stream !== true) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: turn.content ?? '',
                      ...(turn.reasoning ? { reasoning_content: turn.reasoning } : {}),
                      ...(turn.toolCalls?.length
                        ? {
                            tool_calls: turn.toolCalls.map((tc, i) => ({
                              index: i,
                              id: tc.id ?? `call_${tc.name}_${i}`,
                              type: 'function',
                              function: {
                                name: tc.name,
                                arguments: tc.argsRaw ?? JSON.stringify(tc.args ?? {})
                              }
                            }))
                          }
                        : {})
                    }
                  }
                ],
                usage: { total_tokens: 0 }
              })
            )
            return
          }
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          if (turn.hold) {
            // Stream everything EXCEPT the terminating [DONE], then hang — the client's
            // abort (req.destroy) closes it. Lets a test cancel mid-turn.
            for (const frame of sseFramesFor(turn).filter((f) => !f.includes('[DONE]')))
              res.write(frame)
            return
          }
          for (const frame of sseFramesFor(turn)) {
            res.write(frame)
          }
          res.end()
        }
        if ((turn.delayMs ?? 0) > 0) {
          setTimeout(respond, turn.delayMs)
        } else {
          respond()
        }
      })
      return
    }
    res.writeHead(404)
    res.end()
  })

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    requests,
    enqueue: (...turns: FakeTurn[]) => {
      queue.push(...turns)
    },
    reset: () => {
      queue.length = 0
      requests.length = 0
    },
    close: () => new Promise<void>((r) => server.close(() => r()))
  }
}
