/**
 * Provider tool sources through the real connector repository and SQLite status owner. The MCP SDK
 * is the external boundary: this fake records sessions so cleanup is observable without a network.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-mcp-provider-source-'))
const sdk = vi.hoisted(() => ({
  connectedCommands: [] as string[],
  closedCommands: [] as string[],
  listedCommands: [] as string[]
}))

vi.mock('electron', () => ({
  app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value).map((byte) => byte ^ 0xa5),
    decryptString: (value: Buffer) =>
      Buffer.from(value)
        .map((byte) => byte ^ 0xa5)
        .toString()
  }
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(readonly options: { command: string }) {}
  }
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    private command = ''

    async connect(transport: { options: { command: string } }): Promise<void> {
      this.command = transport.options.command
      sdk.connectedCommands.push(this.command)
    }

    async listTools(): Promise<{
      tools: Array<{ name: string; description: string; inputSchema: { type: string } }>
    }> {
      sdk.listedCommands.push(this.command)
      return {
        tools: [
          {
            name: 'generic_read',
            description: 'Read through generic MCP',
            inputSchema: { type: 'object' }
          }
        ]
      }
    }

    async close(): Promise<void> {
      sdk.closedCommands.push(this.command)
    }
  }
}))

const sources = new Map<
  number,
  {
    tools: Array<{ name: string; description: string; inputSchema: { type: string } }>
    verify: () => Promise<void>
    callTool: () => Promise<{ ok: true; result: string }>
  }
>()

beforeEach(async () => {
  sdk.connectedCommands.length = 0
  sdk.closedCommands.length = 0
  sdk.listedCommands.length = 0
  sources.clear()

  const connectors = await import('../mcp')
  const { getDB } = await import('../database')
  const { listSecretKeys } = await import('../secrets')
  const { HOOKS, registerHook } = await import('../bootstrap/hookRegistry')
  connectors.listConnectors()
  listSecretKeys()
  getDB().exec('DELETE FROM connectors; DELETE FROM secrets')
  registerHook(HOOKS.mcpConnectorToolSource, (id: number) => sources.get(id))
})

afterAll(async () => {
  const { getDB } = await import('../database')
  getDB().close()
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

function providerSource(
  verify: () => Promise<void>
): typeof sources extends Map<unknown, infer V> ? V : never {
  return {
    tools: [
      {
        name: 'provider_read',
        description: 'Read through the provider source',
        inputSchema: { type: 'object' }
      }
    ],
    verify,
    callTool: () => Promise.resolve({ ok: true, result: 'provider result' })
  }
}

describe('provider-owned connector source', () => {
  it('opens and closes the first-account session before provider verification', async () => {
    const connectors = await import('../mcp')
    const id = connectors.addConnector({
      name: 'First provider account',
      transport: 'stdio',
      command: 'provider-first-account'
    })
    let verifications = 0
    sources.set(
      id,
      providerSource(async () => {
        verifications += 1
      })
    )

    expect(await connectors.testConnector(id)).toMatchObject({
      ok: true,
      tools: [expect.objectContaining({ name: 'provider_read' })]
    })
    expect(verifications).toBe(1)
    expect(sdk.connectedCommands).toEqual(['provider-first-account'])
    expect(sdk.closedCommands).toEqual(['provider-first-account'])
    expect(sdk.listedCommands).toEqual([])
  })

  it('uses saved OAuth state for verification and persists provider failures', async () => {
    const connectors = await import('../mcp')
    const { setSecret } = await import('../secrets')
    const id = connectors.addConnector({
      name: 'Returning provider account',
      transport: 'stdio',
      command: 'provider-returning-account'
    })
    expect(setSecret(`connector:${id}:oauth:tokens`, '{"access_token":"saved"}')).toBe(true)
    sources.set(
      id,
      providerSource(() => Promise.reject(new Error('provider verification failed')))
    )

    expect(await connectors.testConnector(id)).toEqual({
      ok: false,
      tools: [],
      error: 'provider verification failed'
    })
    expect(sdk.connectedCommands).toEqual([])
    expect(sdk.closedCommands).toEqual([])
    expect(connectors.listConnectors()[0]).toMatchObject({
      status: 'error',
      status_detail: 'provider verification failed'
    })
  })

  it('falls back to generic MCP discovery and closes every session', async () => {
    const connectors = await import('../mcp')
    const id = connectors.addConnector({
      name: 'Generic connector',
      transport: 'stdio',
      command: 'generic-connector'
    })

    expect(await connectors.testConnector(id)).toMatchObject({
      ok: true,
      tools: [expect.objectContaining({ name: 'generic_read' })]
    })
    expect(await connectors.fetchTools(id)).toEqual([
      expect.objectContaining({ name: 'generic_read' })
    ])
    expect(sdk.connectedCommands).toEqual(['generic-connector', 'generic-connector'])
    expect(sdk.listedCommands).toEqual(['generic-connector', 'generic-connector'])
    expect(sdk.closedCommands).toEqual(['generic-connector', 'generic-connector'])
  })
})
