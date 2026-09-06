import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OffGridApplication } from '@offgrid/application'
import type { GenerationRequest, RemoteServerConfiguration, RuntimeModel } from '@offgrid/models'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-mcp-text-'))
vi.mock('electron', () => ({
  app: { getPath: () => profile, isPackaged: false, getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] }
}))

const generation = { requests: [] as GenerationRequest[] }
let application: OffGridApplication
let releaseApplication: () => void
let buildMcpServer: typeof import('../mcp-server').buildMcpServer

beforeAll(async () => {
  const [{ createOffGridApplication }, applicationAccess, mcpServer, modelServices] = await Promise.all([
    import('@offgrid/application'),
    import('../composition/application-access'),
    import('../mcp-server'),
    import('../model-services')
  ])
  const selections = new Map<string, string>()
  let remoteConfiguration: RemoteServerConfiguration = {
    version: 1,
    activeServerId: null,
    servers: []
  }
  const model: RuntimeModel = {
    id: 'mcp-text-model',
    name: 'MCP text model',
    kind: 'text',
    modality: 'text' as const,
    source: 'local' as const,
    adapterId: 'mcp-runtime',
    providerId: 'test-runtime',
    capabilities: { textGeneration: true },
    installed: true,
    ready: true,
    loaded: true
  }
  application = createOffGridApplication({
    models: {
      ...modelServices.desktopModelWorkspacePorts,
      selection: {
        read: (modality) => selections.get(modality) ?? null,
        write: (modality, routeId) => {
          if (routeId === null) selections.delete(modality)
          else selections.set(modality, routeId)
        }
      },
      memory: {
        current: () => ({ totalMB: 16_000, availableMB: 8_000, platform: 'desktop' })
      },
      remote: {
        configuration: {
          read: () => remoteConfiguration,
          write: (next) => {
            remoteConfiguration = next
          }
        },
        credentials: {
          read: async () => null,
          write: async () => undefined,
          remove: async () => undefined
        },
        providers: { register: async () => undefined, unregister: async () => undefined },
        activateManaged: async () => ({})
      },
      remoteInventory: { adapterId: (modality) => `test.remote.${modality}` },
      inventoryAdapters: [{ id: model.adapterId, listModels: async () => [model] }],
      generationAdapters: [
        {
          id: model.adapterId,
          async *generate(_model, request) {
            generation.requests.push(request)
            const last = (request.messages ?? []).at(-1)
            const prompt = Array.isArray(last?.content)
              ? last.content.find((part) => part.type === 'text')?.text ?? ''
              : last?.content ?? ''
            yield { content: `answer to: ${prompt}`, finishReason: 'stop' as const }
          }
        }
      ]
    }
  })
  releaseApplication = applicationAccess.registerDesktopApplication(application)
  await application.start()
  const selected = await application.models.select({ modality: 'text', modelId: model.id })
  if (!selected.ok) throw new Error('The MCP text test model could not be selected.')
  buildMcpServer = mcpServer.buildMcpServer
})

afterAll(async () => {
  await application.stop()
  releaseApplication()
  fs.rmSync(profile, { recursive: true, force: true })
})

beforeEach(() => {
  generation.requests.length = 0
})

async function connect(): Promise<{ client: Client; close(): Promise<void> }> {
  const server = buildMcpServer(false)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(clientTransport)
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    }
  }
}

describe('gateway MCP server text tools', () => {
  it('generates text through Shared with the gateway profile and the client cap', async () => {
    const connection = await connect()
    try {
      const tools = await connection.client.listTools()
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['generate_text', 'describe_image'])
      )
      expect(tools.tools.map((tool) => tool.name)).not.toContain('run_action')

      const result = await connection.client.callTool({
        name: 'generate_text',
        arguments: { prompt: 'hi', system: 'be brief', max_tokens: 64 }
      })
      expect(result.content).toEqual([{ type: 'text', text: 'answer to: be brief\n\nhi' }])
      expect(generation.requests[0]).toMatchObject({
        operation: { type: 'text' },
        profile: 'gateway-request',
        maxTokens: 64,
        identity: {
          conversationId: expect.stringMatching(/^mcp:/),
          turnId: expect.stringMatching(/^mcp:/)
        }
      })
    } finally {
      await connection.close()
    }
  })

  it('uses the default cap when the client names none', async () => {
    const connection = await connect()
    try {
      await connection.client.callTool({ name: 'generate_text', arguments: { prompt: 'x' } })
      expect(generation.requests[0]).toMatchObject({ maxTokens: 2_048 })
    } finally {
      await connection.close()
    }
  })
})
