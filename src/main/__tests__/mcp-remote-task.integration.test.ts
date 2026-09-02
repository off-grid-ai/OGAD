import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

vi.mock('../llm', () => ({
  llm: {
    chat: vi.fn(),
    getModelsDir: vi.fn(() => process.cwd())
  }
}))
vi.mock('../imagegen', () => ({ generateImage: vi.fn(), imageGenStatus: () => ({ ready: false }) }))
vi.mock('../tts', () => ({ synthesize: vi.fn() }))
vi.mock('../embeddings', () => ({ embeddings: { generateEmbedding: vi.fn() } }))
vi.mock('../rag/extractors', () => ({ desktopExtraction: {} }))

const { buildMcpServer } = await import('../mcp-server')
const { authorizeActionRequest, registerActiveActionCredentials } = await import('../mcp-auth')
const { registerRemoteTaskPermissionProvider } = await import('../remote-task-permission')
const { registerToolExtension, unregisterToolExtension } = await import('../tools')
const { configureTaskExecutionDevice } = await import('../tasks/task-history')

const calls: Array<{
  name: string
  args: Record<string, unknown>
  conversationId?: string
  taskLaunch?: { launchId: string; requestingDeviceId: string }
}> = []
const executionBoundary = {
  id: 'remote-task-integration-boundary',
  category: 'tool' as const,
  schemas: () => [],
  canHandle: (name: string) => name === 'web_use' || name === 'computer_use',
  execute: (
    name: string,
    args: Record<string, unknown>,
    context?: {
      conversationId?: string
      taskLaunch?: { launchId: string; requestingDeviceId: string }
    }
  ) => {
    calls.push({
      name,
      args,
      conversationId: context?.conversationId,
      taskLaunch: context?.taskLaunch
    })
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
  beforeEach(() => {
    configureTaskExecutionDevice({ id: 'desktop-1', name: 'Studio Mac' })
  })

  afterEach(() => {
    calls.length = 0
    unregisterToolExtension(executionBoundary.id, executionBoundary)
    registerRemoteTaskPermissionProvider(null)
    registerActiveActionCredentials(null)
  })

  it.each(['web_use', 'computer_use'] as const)(
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
              launchId: `launch-${name}-107`,
              deviceId: 'mobile-1',
              deviceName: 'Release phone',
              executionDeviceId: 'desktop-1'
            }
          }
        })
        expect(result.isError).not.toBe(true)
        expect(calls).toEqual([
          {
            name,
            args: { goal: 'Open the release dashboard' },
            conversationId: 'mobile-chat-107',
            taskLaunch: {
              launchId: `launch-${name}-107`,
              requestingDeviceId: 'mobile-1'
            }
          }
        ])
      } finally {
        await session.close()
      }
    }
  )

  it('rejects a mismatched authenticated origin before execution', async () => {
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
            launchId: 'launch-mismatch-107',
            deviceId: 'another-mobile',
            executionDeviceId: 'desktop-1'
          }
        }
      })
      expect(result.isError).toBe(true)
      expect(calls).toEqual([])
    } finally {
      await session.close()
    }
  })

  it('rejects a paired Mobile after this Desktop turns remote task access off', async () => {
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
            launchId: 'launch-disabled-107',
            deviceId: 'mobile-1',
            executionDeviceId: 'desktop-1'
          }
        }
      })
      expect(result).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: 'Remote task access is disabled for this device.' }]
      })
      expect(calls).toEqual([])
    } finally {
      await session.close()
    }
  })

  it('rejects a task routed to a different Desktop instead of falling back locally', async () => {
    registerToolExtension(executionBoundary)
    registerRemoteTaskPermissionProvider(() => true)
    const session = await clientFor('mobile-1')
    try {
      const result = await session.client.callTool({
        name: 'computer_use',
        arguments: { goal: 'Open the release dashboard', execution_device: 'Office Mac' },
        _meta: {
          'ai.offgrid/taskOrigin': {
            conversationId: 'mobile-chat-107',
            launchId: 'launch-other-desktop-107',
            deviceId: 'mobile-1',
            executionDeviceId: 'desktop-2'
          }
        }
      })
      expect(result).toMatchObject({
        isError: true,
        content: [
          {
            type: 'text',
            text: 'This task was routed to Studio Mac, not its selected Desktop.'
          }
        ]
      })
      expect(calls).toEqual([])
    } finally {
      await session.close()
    }
  })
})
