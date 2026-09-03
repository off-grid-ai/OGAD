import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-active-text-model-'))

vi.mock('electron', () => ({
  app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

import { llm } from '../llm'
import {
  getActiveRemoteVisionServer,
  removeRemoteVisionServer,
  setRemoteVisionServerSettings
} from '../vision/remote-vision-server'
import { planTask } from '../tools/planner'
import { toolChat } from '../tools'
import { generateDesktopMessages } from '../desktop-generation'

interface RecordedRequest {
  body: Record<string, unknown>
  authorization?: string
}

interface RemoteTurn {
  content?: string
  reasoning?: string
  toolCall?: { id: string; name: string; arguments: string }
  error?: { status: number; body: unknown }
  hold?: boolean
}

const turns: RemoteTurn[] = []
const requests: RecordedRequest[] = []
let remoteServer: http.Server
let remoteServerId = ''
const platformFetch = globalThis.fetch.bind(globalThis)

/**
 * The test server is a plain loopback socket, while the stored credentialed endpoint
 * must remain HTTPS. This boundary represents local TLS termination and forwards only
 * this test origin to the loopback server. All Off Grid URL policy, authorization,
 * routing, request shaping, and response parsing remain production code.
 */
function installLoopbackTlsBoundary(port: number): void {
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const raw =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const url = new URL(raw)
    if (url.protocol === 'https:' && url.hostname === '127.0.0.1' && url.port === String(port)) {
      url.protocol = 'http:'
      if (input instanceof Request) return platformFetch(new Request(url, input), init)
      return platformFetch(url, init)
    }
    return platformFetch(input, init)
  })
}

function completionFrames(turn: RemoteTurn): string[] {
  const frame = (delta: Record<string, unknown>, finishReason: string | null = null): string =>
    `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason }] })}\n\n`
  return [
    ...(turn.reasoning ? [frame({ reasoning_content: turn.reasoning })] : []),
    ...(turn.toolCall
      ? [
          frame({
            tool_calls: [
              {
                index: 0,
                id: turn.toolCall.id,
                type: 'function',
                function: {
                  name: turn.toolCall.name,
                  arguments: turn.toolCall.arguments
                }
              }
            ]
          })
        ]
      : []),
    ...(turn.content ? [frame({ content: turn.content })] : []),
    frame({}, turn.toolCall ? 'tool_calls' : 'stop'),
    'data: [DONE]\n\n'
  ]
}

function startRemoteServer(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({
            data: [
              {
                id: 'openai/gpt-5.6',
                name: 'GPT-5.6',
                supported_parameters: ['tools', 'temperature', 'top_p'],
                reasoning: {
                  supported_efforts: ['low', 'medium', 'high'],
                  default_effort: 'medium'
                }
              },
              {
                id: 'bytedance-research/ui-tars-1.5-7b',
                name: 'UI-TARS 1.5 7B',
                supported_parameters: ['temperature', 'top_p']
              }
            ]
          })
        )
        return
      }
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404).end()
        return
      }
      let rawBody = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => {
        rawBody += chunk
      })
      request.on('end', () => {
        requests.push({
          body: JSON.parse(rawBody) as Record<string, unknown>,
          ...(request.headers.authorization ? { authorization: request.headers.authorization } : {})
        })
        const turn = turns.shift() ?? { content: '' }
        if (turn.error) {
          response.writeHead(turn.error.status, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify(turn.error.body))
          return
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const frames = completionFrames(turn)
        const visibleFrames = turn.hold
          ? frames.filter((candidate) => !candidate.includes('[DONE]'))
          : frames
        for (const candidate of visibleFrames) response.write(candidate)
        if (!turn.hold) response.end()
      })
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

beforeAll(async () => {
  const { configureRuntime } = await import('../runtime-env')
  configureRuntime({ dataDir: TMP_DIR })
  remoteServer = await startRemoteServer()
  const port = (remoteServer.address() as AddressInfo).port
  installLoopbackTlsBoundary(port)
  // Boot the same composition root as Desktop before a remote selection projects
  // into Shared LLMService.
  await import('../model-services')
  const settings = await setRemoteVisionServerSettings({
    provider: 'openrouter',
    name: 'Test OpenRouter',
    endpoint: `https://127.0.0.1:${port}`,
    model: 'openai/gpt-5.6',
    selections: { text: 'openai/gpt-5.6' },
    catalog: {
      text: [
        {
          id: 'openai/gpt-5.6',
          name: 'GPT-5.6',
          capabilities: {
            supportsVision: true,
            supportsToolCalling: true,
            supportsThinking: true
          }
        },
        {
          id: 'bytedance-research/ui-tars-1.5-7b',
          name: 'UI-TARS 1.5 7B',
          capabilities: {
            supportsVision: true,
            supportsToolCalling: false,
            supportsThinking: false
          }
        }
      ]
    },
    apiKey: 'test-api-key'
  })
  remoteServerId = settings.activeServerId ?? ''
})

beforeEach(() => {
  turns.length = 0
  requests.length = 0
})

afterAll(async () => {
  if (remoteServerId) await removeRemoteVisionServer(remoteServerId)
  vi.unstubAllGlobals()
  await new Promise<void>((resolve, reject) => {
    remoteServer.close((error) => (error ? reject(error) : resolve()))
  })
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true })
  } catch {
    // Best effort after the SQLite test process releases its handles.
  }
})

describe('active text model transport', () => {
  it('uses the selected OpenRouter model for planner, chat, and tools', async () => {
    const { desktopModelServices } = await import('../model-services')
    const inventory = await desktopModelServices.refresh()
    const remoteText = inventory.find(
      (model) => model.serverId === remoteServerId && model.modality === 'text'
    )
    expect(desktopModelServices.llm.active('text')).toMatchObject({
      selectedId: remoteText?.routeId,
      model: { serverId: remoteServerId, id: 'openai/gpt-5.6' }
    })
    const remoteToolSelection = inventory.find(
      (model) => model.serverId === remoteServerId && model.modality === 'tool_selection'
    )
    expect(remoteToolSelection?.capabilities.thinking).toBe(remoteText?.capabilities.thinking)
    expect(remoteToolSelection?.capabilities.thinking).toBe(true)

    turns.push(
      { content: JSON.stringify({ steps: [] }) },
      { reasoning: 'Use the active remote model.', content: 'Remote chat answer.' },
      {
        reasoning: 'Call the requested tool.',
        toolCall: { id: 'call_time', name: 'get_datetime', arguments: '{}' }
      }
    )

    await expect(planTask('Answer directly.', [], [])).resolves.toEqual({ steps: [] })

    const deltas: Array<{ text: string; kind: 'content' | 'reasoning' }> = []
    const chatResult = await generateDesktopMessages(
      [{ role: 'user', content: 'Use the selected model.' }],
      {
        thinking: true,
        maxTokens: 700,
        timeoutMs: 5_000,
        events: {
          chunk: (chunk) => {
            if (chunk.reasoning) deltas.push({ text: chunk.reasoning, kind: 'reasoning' })
            if (chunk.content) deltas.push({ text: chunk.content, kind: 'content' })
          }
        }
      }
    )
    expect(chatResult.content).toBe('Remote chat answer.')
    expect(deltas).toEqual([
      { text: 'Use the active remote model.', kind: 'reasoning' },
      { text: 'Remote chat answer.', kind: 'content' }
    ])

    const toolResult = await generateDesktopMessages(
      [{ role: 'user', content: 'What time is it?' }],
      {
        thinking: true,
        topP: 0.8,
        maxTokens: 900,
        tools: [
          {
            type: 'function',
            function: { name: 'get_datetime', parameters: { type: 'object' } }
          }
        ],
        toolChoice: 'auto',
        toolHandling: 'return',
        timeoutMs: 5_000
      }
    )
    expect(toolResult.toolCalls).toEqual([
      { id: 'call_time', name: 'get_datetime', arguments: '{}' }
    ])

    expect(requests).toHaveLength(3)
    expect(requests.every(({ body }) => body.model === 'openai/gpt-5.6')).toBe(true)
    expect(requests.every(({ body }) => body.stream === true)).toBe(true)
    expect(requests.every(({ authorization }) => authorization === 'Bearer test-api-key')).toBe(
      true
    )
    expect(requests[0]?.body.response_format).toBeTruthy()
    expect(requests[0]?.body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: {
        name: 'task_plan',
        strict: true,
        schema: {
          additionalProperties: false,
          properties: {
            steps: {
              items: {
                additionalProperties: false,
                properties: {
                  args: { type: 'string' },
                  bindings: { items: { additionalProperties: false } }
                }
              }
            }
          }
        }
      }
    })
    expect(requests[0]?.body.reasoning).toEqual({ effort: 'medium' })
    expect(requests[1]?.body.reasoning).toEqual({ effort: 'medium' })
    expect(requests[2]?.body).toMatchObject({
      reasoning: { effort: 'medium' },
      top_p: 0.8,
      tool_choice: 'auto'
    })
    expect(requests[2]?.body.tools).toHaveLength(1)
  })

  it('does not send tools to a selected OpenRouter model without native tool support', async () => {
    await setRemoteVisionServerSettings({
      serverId: remoteServerId,
      provider: 'openrouter',
      name: 'Test OpenRouter',
      endpoint: `https://127.0.0.1:${(remoteServer.address() as AddressInfo).port}`,
      model: 'bytedance-research/ui-tars-1.5-7b',
      selections: { text: 'bytedance-research/ui-tars-1.5-7b' },
      apiKey: 'test-api-key'
    })

    try {
      const result = await toolChat('Send a message to Ali.', [])
      expect(result).toMatchObject({
        answer: expect.stringContaining('UI-TARS 1.5 7B cannot act as the Chat tool planner'),
        toolCalls: []
      })
      expect(result.answer).toContain('Select it as the Computer Use specialist instead')
      expect(requests).toHaveLength(0)

      await expect(
        generateDesktopMessages([{ role: 'user', content: 'Send a message.' }], {
          tools: [
            {
              type: 'function',
              function: { name: 'send_message', parameters: { type: 'object' } }
            }
          ],
          toolHandling: 'return',
          timeoutMs: 5_000,
          profile: 'tool-loop'
        })
      ).rejects.toThrow('UI-TARS 1.5 7B cannot act as the Chat tool planner')
      expect(requests).toHaveLength(0)
    } finally {
      await setRemoteVisionServerSettings({
        serverId: remoteServerId,
        provider: 'openrouter',
        name: 'Test OpenRouter',
        endpoint: `https://127.0.0.1:${(remoteServer.address() as AddressInfo).port}`,
        model: 'openai/gpt-5.6',
        selections: { text: 'openai/gpt-5.6' },
        apiKey: 'test-api-key'
      })
    }
  })

  it('aborts an in-flight selected-remote request and returns only received evidence', async () => {
    turns.push({ content: 'Partial remote answer.', hold: true })
    const controller = new AbortController()

    const remote = getActiveRemoteVisionServer()
    expect(remote).not.toBeNull()
    const result = await llm.streamChatRemote(
      remote!,
      [{ role: 'user', content: 'Stop this request.' }],
      (_text, kind) => {
        if (kind === 'content') controller.abort()
      },
      { signal: controller.signal },
      5_000
    )

    expect(result.content).toBe('Partial remote answer.')
    expect(requests).toHaveLength(1)
  })

  it('surfaces the selected remote provider error without trying a local model', async () => {
    turns.push({
      error: {
        status: 429,
        body: {
          error: {
            message: 'Rate limit reached.',
            metadata: { provider_name: 'OpenRouter', raw: 'Try again later.' }
          }
        }
      }
    })

    await expect(
      generateDesktopMessages([{ role: 'user', content: 'Use the selected model.' }], {
        profile: 'chat',
        timeoutMs: 5_000,
        maxTokens: 200
      })
    ).rejects.toThrow('Remote server returned HTTP 429 from OpenRouter: Try again later.')
    expect(requests).toHaveLength(1)
  })
})
