import { afterEach, describe, expect, it } from 'vitest'
import * as http from 'node:http'
import { streamRemoteChatCompletion } from '../remote-chat'

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
})
