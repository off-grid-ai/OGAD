import { afterEach, describe, expect, it } from 'vitest'
import * as http from 'node:http'
import {
  forgetRemoteServerFacts,
  remoteContextWindow,
  streamRemoteChatCompletion
} from '../remote-chat'

let server: http.Server | null = null

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = null
})

describe('remote Computer Use sampling transport', () => {
  it('forwards supported Qwen sampling fields without breaking an OpenAI-compatible request', async () => {
    let requestBody: Record<string, unknown> = {}
    server = http.createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk) => {
        raw += String(chunk)
      })
      request.on('end', () => {
        requestBody = JSON.parse(raw) as Record<string, unknown>
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.end(
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
        )
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as import('node:net').AddressInfo).port

    const result = await streamRemoteChatCompletion({
      remote: {
        id: 'fixture',
        name: 'Fixture',
        provider: 'lmstudio',
        endpoint: `http://127.0.0.1:${port}/v1`,
        model: 'qwen-fixture',
        apiKey: ''
      },
      request: {
        messages: [{ role: 'user', content: 'choose' }],
        maxTokens: 32,
        temperature: 1,
        topP: 0.95,
        topK: 20,
        minP: 0,
        presencePenalty: 0,
        repeatPenalty: 1
      },
      onDelta: () => undefined,
      options: { timeoutMs: 5_000 }
    })

    expect(result.content).toBe('ok')
    expect(requestBody).toMatchObject({
      temperature: 1,
      top_p: 0.95,
      top_k: 20,
      min_p: 0,
      presence_penalty: 0,
      repeat_penalty: 1,
      repetition_penalty: 1
    })
  })

  it('sends the thinking budget to a server that describes each of its models only on request', async () => {
    // An Off Grid gateway keeping several models loaded (a llama.cpp router behind it) has no one
    // local model to describe: /props answers per model and 502s without one.
    let requestBody: Record<string, unknown> = {}
    server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://fixture')
      if (request.method === 'GET' && url.pathname === '/props') {
        if (url.searchParams.get('model') !== 'kept-model') {
          response.writeHead(502, { 'Content-Type': 'application/json' })
          response.end('{"error":{"message":"Local model not ready"}}')
          return
        }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({ chat_template: '{% if enable_thinking %}<think>{% endif %}' })
        )
        return
      }
      let raw = ''
      request.on('data', (chunk) => {
        raw += String(chunk)
      })
      request.on('end', () => {
        requestBody = JSON.parse(raw) as Record<string, unknown>
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.end(
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
        )
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as import('node:net').AddressInfo).port

    await streamRemoteChatCompletion({
      remote: {
        id: 'gateway',
        name: 'Gateway',
        provider: 'ogad',
        endpoint: `http://127.0.0.1:${port}/v1`,
        model: 'kept-model',
        apiKey: ''
      },
      request: {
        messages: [{ role: 'user', content: 'think briefly' }],
        maxTokens: 32,
        temperature: 0.7,
        thinking: true,
        reasoningBudget: 512
      },
      onDelta: () => undefined,
      options: { timeoutMs: 5_000 }
    })

    expect(requestBody).toMatchObject({
      chat_template_kwargs: { enable_thinking: true },
      reasoning_budget_tokens: 512
    })
  })

  // A template that switches thinking with reasoning_effort and opens <think> in the prompt
  // (Hunyuan's, among others): llama.cpp does not recognise it, so the reply carries the thinking
  // in content and only closes the block.
  function promptOpensThinkingServer(stream: string, seen: Record<string, unknown>[]): http.Server {
    return http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://fixture')
      let raw = ''
      request.on('data', (chunk) => {
        raw += String(chunk)
      })
      request.on('end', () => {
        if (request.method === 'GET' && url.pathname === '/props') {
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end(
            JSON.stringify({
              chat_template: '{{ reasoning_effort }}<think>',
              chat_template_caps: { supports_reasoning_effort: true }
            })
          )
          return
        }
        if (url.pathname === '/apply-template') {
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ prompt: '<user>Hi<assistant><think>' }))
          return
        }
        seen.push(JSON.parse(raw) as Record<string, unknown>)
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.end(stream)
      })
    })
  }

  const sse = (...parts: string[]): string =>
    parts
      .map((text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
      .join('') + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'

  it('reads thinking that the prompt opened as reasoning, and the rest as the answer', async () => {
    const seen: Record<string, unknown>[] = []
    server = promptOpensThinkingServer(
      sse('The user asks about ', 'primes.</thi', 'nk>There are 10.'),
      seen
    )
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as import('node:net').AddressInfo).port
    const reasoning: string[] = []

    const result = await streamRemoteChatCompletion({
      remote: {
        id: 'router',
        name: 'Router',
        provider: 'ogad',
        endpoint: `http://127.0.0.1:${port}/v1`,
        model: 'hy-like',
        apiKey: ''
      },
      request: {
        messages: [{ role: 'user', content: 'primes?' }],
        maxTokens: 64,
        temperature: 0.7,
        thinking: true,
        reasoningBudget: 512
      },
      onDelta: (text, kind) => {
        if (kind === 'reasoning') reasoning.push(text)
      },
      options: { timeoutMs: 5_000 }
    })

    expect(seen[0]).toMatchObject({ chat_template_kwargs: { enable_thinking: true } })
    expect(seen[0]).not.toHaveProperty('reasoning_effort')
    expect(reasoning.join('')).toBe('The user asks about primes.')
    expect(result.content).toBe('There are 10.')
  })

  it('keeps the answer when the prompt opened thinking but the model never closed it', async () => {
    const seen: Record<string, unknown>[] = []
    server = promptOpensThinkingServer(sse('There are ', '10.'), seen)
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as import('node:net').AddressInfo).port

    const result = await streamRemoteChatCompletion({
      remote: {
        id: 'router',
        name: 'Router',
        provider: 'ogad',
        endpoint: `http://127.0.0.1:${port}/v1`,
        model: 'hy-like-2',
        apiKey: ''
      },
      request: {
        messages: [{ role: 'user', content: 'primes?' }],
        maxTokens: 64,
        temperature: 0.7,
        thinking: true
      },
      onDelta: () => undefined,
      options: { timeoutMs: 5_000 }
    })

    expect(result.content).toBe('There are 10.')
  })
})

describe('remote context window', () => {
  it('reads a changed window again once the server is tested or saved', async () => {
    let window = 16_384
    server = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'flint', context_length: window }] }))
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as import('node:net').AddressInfo).port
    const remote = {
      id: 'gateway',
      name: 'Gateway',
      provider: 'ogad' as const,
      endpoint: `http://127.0.0.1:${port}/v1`,
      model: 'flint',
      apiKey: ''
    }

    expect(await remoteContextWindow(remote)).toBe(16_384)
    window = 262_144
    expect(await remoteContextWindow(remote)).toBe(16_384)
    forgetRemoteServerFacts(`${remote.endpoint}/`)
    expect(await remoteContextWindow(remote)).toBe(262_144)
  })
})

describe('a request waiting on an Off Grid gateway', () => {
  const gateway = (stream: string): Promise<string> => {
    server = http.createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.end(stream)
      })
    })
    return new Promise((resolve) =>
      server!.listen(0, '127.0.0.1', () =>
        resolve(`http://127.0.0.1:${(server!.address() as import('node:net').AddressInfo).port}/v1`)
      )
    )
  }
  const frame = (body: unknown): string => `data: ${JSON.stringify(body)}\n\n`
  const request = {
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 32,
    temperature: 0.7
  }

  it('says what it waits for, then answers', async () => {
    const endpoint = await gateway(
      ': waiting\n\n' +
        frame({ choices: [], offgrid_status: { phase: 'queued', ahead: 2 } }) +
        frame({ choices: [], offgrid_status: { phase: 'loading', model: 'Flint' } }) +
        frame({ choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }] }) +
        'data: [DONE]\n\n'
    )
    const lines: string[] = []
    const result = await streamRemoteChatCompletion({
      remote: {
        id: 'pod',
        name: 'RTX Pro 6000',
        provider: 'custom',
        endpoint,
        model: 'flint',
        apiKey: ''
      },
      request,
      onDelta: () => undefined,
      options: { timeoutMs: 5_000, onWaitStatus: (line) => lines.push(line) }
    })
    expect(lines).toEqual(['Waiting for RTX Pro 6000 · 2 ahead', 'RTX Pro 6000 is loading Flint…'])
    expect(result.content).toBe('hello')
  })

  it('fails when the gateway reports an error inside the stream', async () => {
    const endpoint = await gateway(
      frame({ error: { message: 'Model could not be selected.' } }) + 'data: [DONE]\n\n'
    )
    await expect(
      streamRemoteChatCompletion({
        remote: {
          id: 'pod',
          name: 'RTX Pro 6000',
          provider: 'custom',
          endpoint,
          model: 'flint',
          apiKey: ''
        },
        request,
        onDelta: () => undefined,
        options: { timeoutMs: 5_000 }
      })
    ).rejects.toThrow('Model could not be selected.')
  })
})
