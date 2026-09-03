import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

// Every heavy engine the server registers tools over is a boundary here; only the text tool runs.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false, getAppPath: () => process.cwd() } }))
vi.mock('../imagegen', () => ({ generateImage: vi.fn(), imageGenStatus: vi.fn() }))
vi.mock('../tts', () => ({}))
vi.mock('../embeddings', () => ({ embeddings: {} }))
vi.mock('../rag/extractors', () => ({ desktopExtraction: {} }))
vi.mock('../tools', () => ({ runTool: vi.fn(), getToolExtensions: () => [] }))
vi.mock('../mcp-auth', () => ({ authorizeActionRequest: () => ({ ok: false }) }))
vi.mock('../remote-task-permission', () => ({ mayRunRemoteTask: () => false }))
vi.mock('../tasks/task-history', () => ({ getTaskExecutionDevice: () => null }))
vi.mock('../desktop-generation', () => ({
  promptMessages: (prompt: string, images: string[]) => [{ role: 'user', content: prompt, images }]
}))
const generation = vi.hoisted(() => ({ requests: [] as unknown[], refreshed: 0 }))
vi.mock('../model-services', () => ({
  desktopModelServices: {
    refresh: async () => void generation.refreshed++,
    generation: {
      generate: async (request: Record<string, unknown>) => {
        generation.requests.push(request)
        return { content: `answer to: ${(request.messages as { content: string }[])[0]!.content}` }
      }
    }
  }
}))

import { buildMcpServer } from '../mcp-server'

beforeEach(() => {
  generation.requests.length = 0
  generation.refreshed = 0
})

async function connect(actionsAllowed = false) {
  const server = buildMcpServer(actionsAllowed)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(clientTransport)
  return client
}

describe('gateway MCP server text tools', () => {
  it('generates text through the shared generation service with the gateway profile and the client cap', async () => {
    const client = await connect()
    const tools = await client.listTools()
    expect(tools.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['generate_text', 'describe_image']))
    // Actions are not offered to an unauthorized caller.
    expect(tools.tools.map((t) => t.name)).not.toContain('run_action')

    const result = await client.callTool({ name: 'generate_text', arguments: { prompt: 'hi', system: 'be brief', max_tokens: 64 } })
    expect(result.content).toEqual([{ type: 'text', text: 'answer to: be brief\n\nhi' }])
    expect(generation.refreshed).toBe(1)
    expect(generation.requests[0]).toMatchObject({
      operation: { type: 'text' },
      profile: 'gateway-request',
      maxTokens: 64,
      identity: { conversationId: expect.stringMatching(/^mcp:/), turnId: expect.stringMatching(/^mcp:/) }
    })
  })

  it('uses the default cap when the client names none', async () => {
    const client = await connect()
    await client.callTool({ name: 'generate_text', arguments: { prompt: 'x' } })
    expect(generation.requests[0]).toMatchObject({ maxTokens: 2_048, messages: [{ content: 'x' }] })
  })
})
