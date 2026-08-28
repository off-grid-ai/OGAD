import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

vi.mock('../llm', () => ({ llm: { chat: vi.fn() } }))
vi.mock('../imagegen', () => ({ generateImage: vi.fn(), imageGenStatus: () => ({ ready: false }) }))
vi.mock('../tts', () => ({ synthesize: vi.fn() }))
vi.mock('../embeddings', () => ({ embeddings: { generateEmbedding: vi.fn() } }))
vi.mock('../rag/extractors', () => ({ desktopExtraction: {} }))

const { buildMcpServer } = await import('../mcp-server')
const { authorizeActionRequest, registerActiveActionCredentials } = await import('../mcp-auth')
const { registerRemoteTaskPermissionProvider } = await import('../remote-task-permission')
const { registerToolExtension, unregisterToolExtension } = await import('../tools')

const calls: Array<{
  name: string
  args: Record<string, unknown>
  conversationId?: string
}> = []
const executionBoundary = {
  id: 'remote-task-integration-boundary',
  category: 'tool' as const,
  schemas: () => [],
  canHandle: (name: string) => name === 'web_use' || name === 'computer_task',
  execute: (name: string, args: Record<string, unknown>, context?: { conversationId?: string }) => {
    calls.push({ name, args, conversationId: context?.conversationId })
    return { text: 'Task started.', authoritative: true as const }
  }
}

async function clientFor(deviceId: string): Promise<{
  client: Client
  close: () => Promise<void>
}> {
  const token = `release-token-${deviceId}-1234567890`
  registerActiveActionCredentials(() => [{ deviceId, token }])
  const authorization = authorizeActionRequest({
    headers: { authorization: `Bearer ${token}` }
  } as never)
  const server = buildMcpServer(authorization.allowed, authorization.deviceId)
  const client = new Client({ name: 'remote-task-integration', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    }
  }
}

describe('authenticated Mobile task calls through the Desktop MCP surface', () => {
  afterEach(() => {
    calls.length = 0
    unregisterToolExtension(executionBoundary.id, executionBoundary)
    registerRemoteTaskPermissionProvider(null)
    registerActiveActionCredentials(null)
  })

  it.each(['web_use', 'computer_task'] as const)(
    'exposes routing for %s, strips it, and starts once in the originating chat',
    async (name) => {
      registerToolExtension(executionBoundary)
      registerRemoteTaskPermissionProvider((deviceId) => deviceId === 'mobile-1')
      const session = await clientFor('mobile-1')
      try {
        const listed = await session.client.listTools()
        const tool = listed.tools.find((candidate) => candidate.name === name)
        expect(tool?.inputSchema).toMatchObject({
          properties: {
            execution_device: {
              type: 'string',
              description:
                'Exact paired Desktop name or alias. Omit to select any enabled connected Desktop.'
            }
          }
        })

        const result = await session.client.callTool({
          name,
          arguments: { goal: 'Open the release dashboard', execution_device: 'Studio Mac' },
          _meta: {
            'ai.offgrid/taskOrigin': {
              conversationId: 'mobile-chat-107',
              deviceId: 'mobile-1',
              deviceName: 'Release phone'
            }
          }
        })
        expect(result.isError).not.toBe(true)
        expect(calls).toEqual([
          {
            name,
            args: { goal: 'Open the release dashboard' },
            conversationId: 'mobile-chat-107'
          }
        ])
      } finally {
        await session.close()
      }
    }
  )

  it('rejects a disabled or mismatched paired device before execution', async () => {
    registerToolExtension(executionBoundary)
    registerRemoteTaskPermissionProvider(() => false)
    const session = await clientFor('mobile-1')
    try {
      const result = await session.client.callTool({
        name: 'web_use',
        arguments: { goal: 'Open the release dashboard' },
        _meta: {
          'ai.offgrid/taskOrigin': {
            conversationId: 'mobile-chat-107',
            deviceId: 'another-mobile'
          }
        }
      })
      expect(result.isError).toBe(true)
      expect(calls).toEqual([])
    } finally {
      await session.close()
    }
  })
})
