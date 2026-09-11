/**
 * Real Desktop remote-chat adapter over a loopback OpenAI-compatible server. HTTP and SSE are real;
 * no Off Grid module, parser, capability cache, or request builder is replaced.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  peekRemoteReasoningMetadata,
  remoteNativeToolCapability,
  remoteReasoningMetadata,
  remoteTextModelTransportError,
  streamRemoteChatCompletion,
  type RemoteTextModelConnection
} from '../remote-chat'

let server: http.Server
let endpoint = ''
let failChat = false
const requests: Array<{ url: string; authorization?: string; body: string }> = []

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      requests.push({
        url: request.url ?? '',
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString()
      })
      if (request.url === '/api/show') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({
            capabilities: ['thinking'],
            template: '{{ if .Think }} low medium high {{ end }}'
          })
        )
        return
      }
      if (request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({
            data: [
              {
                id: 'remote-model',
                name: 'Remote Model',
                supported_parameters: ['tools'],
                reasoning: { supported: true }
              },
              {
                id: 'no-tools',
                name: 'Text Only',
                supported_parameters: []
              }
            ]
          })
        )
        return
      }
      if (request.url === '/v1/slow/chat/completions') return
      if (failChat) {
        response.writeHead(429, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'capacity reached' } }))
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"reasoning_content":"checking "}}]}\n')
      response.write('data: {"choices":[{"delta":{"content":"answer"}}]}\n')
      response.end('data: [DONE]\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
})

describe('Desktop remote chat adapter', () => {
  it('discovers capabilities and streams one authenticated OpenAI-compatible response', async () => {
    const remote: RemoteTextModelConnection = {
      id: 'server-1',
      name: 'Remote Model',
      provider: 'openrouter',
      endpoint,
      model: 'remote-model',
      apiKey: 'private-key'
    }

    const reasoning = await remoteReasoningMetadata(remote)
    expect(reasoning).toEqual(peekRemoteReasoningMetadata(remote))
    await expect(remoteNativeToolCapability(remote)).resolves.toMatchObject({
      status: 'supported',
      modelName: 'Remote Model'
    })

    const deltas: Array<{ text: string; kind: string }> = []
    await expect(
      streamRemoteChatCompletion({
        remote,
        request: {
          messages: [{ role: 'user', content: 'Reply privately' }],
          maxTokens: 64,
          temperature: 0.2,
          topP: 0.9,
          thinking: true
        },
        onDelta: (text, kind) => deltas.push({ text, kind }),
        options: { timeoutMs: 1_000 }
      })
    ).resolves.toMatchObject({ content: 'answer' })
    expect(deltas).toEqual([
      { text: 'checking ', kind: 'reasoning' },
      { text: 'answer', kind: 'content' }
    ])
    expect(requests.every(({ authorization }) => authorization === 'Bearer private-key')).toBe(true)
    const completion = requests.find(({ url }) => url === '/v1/chat/completions')
    expect(JSON.parse(completion?.body ?? '{}')).toMatchObject({
      model: 'remote-model',
      messages: [{ role: 'user', content: 'Reply privately' }],
      max_tokens: 64,
      temperature: 0.2,
      top_p: 0.9,
      stream: true
    })

    failChat = true
    await expect(
      streamRemoteChatCompletion({
        remote,
        request: { messages: [], maxTokens: 8, temperature: 0 },
        onDelta: () => undefined,
        options: {}
      })
    ).rejects.toThrow('capacity reached')
  })

  it('refuses unsupported tools, preserves cancellation, and reports an idle stream timeout', async () => {
    failChat = false
    const unsupported: RemoteTextModelConnection = {
      id: 'server-2',
      name: 'Text Only',
      provider: 'openrouter',
      endpoint,
      model: 'no-tools',
      apiKey: ''
    }
    await expect(
      streamRemoteChatCompletion({
        remote: unsupported,
        request: {
          messages: [],
          maxTokens: 8,
          temperature: 0,
          tools: [{ type: 'function', function: { name: 'search' } }]
        },
        onDelta: () => undefined,
        options: {}
      })
    ).rejects.toThrow('Text Only cannot act as the Chat tool planner')

    const cancelled = new AbortController()
    cancelled.abort(new Error('user stopped'))
    await expect(
      streamRemoteChatCompletion({
        remote: unsupported,
        request: { messages: [], maxTokens: 8, temperature: 0 },
        onDelta: () => undefined,
        options: { signal: cancelled.signal }
      })
    ).resolves.toMatchObject({ content: '', toolCalls: [] })

    const slow = { ...unsupported, provider: 'custom' as const, endpoint: `${endpoint}/slow` }
    await expect(
      streamRemoteChatCompletion({
        remote: slow,
        request: { messages: [], maxTokens: 8, temperature: 0 },
        onDelta: () => undefined,
        options: { timeoutMs: 20 }
      })
    ).rejects.toThrow('Remote text model request timed out.')

    const ollama = { ...unsupported, provider: 'ollama' as const, model: 'thinking-model' }
    await expect(remoteReasoningMetadata(ollama)).resolves.toMatchObject({
      transport: 'ollama',
      control: 'effort',
      supportedEfforts: ['low', 'medium', 'high']
    })
    await expect(remoteNativeToolCapability(ollama)).resolves.toEqual({
      status: 'unknown',
      modelName: 'Text Only'
    })

    const compatible = {
      ...unsupported,
      provider: 'custom' as const,
      model: 'remote-model'
    }
    await expect(remoteReasoningMetadata(compatible)).resolves.toMatchObject({
      transport: 'openai-compatible',
      control: 'no-control'
    })
    expect(remoteTextModelTransportError('offline').message).toBe(
      'Remote text model request failed.'
    )
    expect(remoteTextModelTransportError(new Error('fetch failed')).message).toBe(
      'Remote text model request failed: fetch failed'
    )
    expect(
      remoteTextModelTransportError(
        new Error('fetch failed', {
          cause: { message: 'connection refused', code: 'ECONNREFUSED' }
        })
      ).message
    ).toBe('Remote text model connection failed: connection refused (ECONNREFUSED).')
  })
})
