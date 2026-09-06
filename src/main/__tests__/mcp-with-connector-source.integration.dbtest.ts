/**
 * withConnector through the real connector repository and SQLite. The registered provider source
 * (the seam Pro registers for REST-backed connectors) must serve multi-step adapters exactly as it
 * serves callConnectorTool; without a source the generic MCP session is opened once and closed.
 * The MCP SDK is the only fake, at its transport boundary.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-mcp-with-connector-'))
const sdk = vi.hoisted(() => ({
  connectedCommands: [] as string[],
  closedCommands: [] as string[],
  calledTools: [] as string[]
}))

vi.mock('electron', () => ({
  app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
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

    async callTool(request: { name: string }): Promise<{ via: string; tool: string }> {
      sdk.calledTools.push(request.name)
      if (request.name === 'explode') throw new Error('generic tool failed')
      return { via: 'generic-mcp', tool: request.name }
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
    callTool: (tool: string, args: unknown) => Promise<{ ok: boolean; result?: unknown; error?: string }>
  }
>()

beforeEach(async () => {
  sdk.connectedCommands.length = 0
  sdk.closedCommands.length = 0
  sdk.calledTools.length = 0
  sources.clear()
  const connectors = await import('../mcp')
  const { getDB } = await import('../database')
  const { HOOKS, registerHook } = await import('../bootstrap/hookRegistry')
  connectors.listConnectors()
  getDB().exec('DELETE FROM connectors')
  registerHook(HOOKS.mcpConnectorToolSource, (id: number) => sources.get(id))
})

afterAll(async () => {
  const { getDB } = await import('../database')
  getDB().close()
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

describe('withConnector honours the registered connector tool source', () => {
  it('routes every call of a multi-step adapter to the source and never opens an MCP session', async () => {
    const connectors = await import('../mcp')
    const id = connectors.addConnector({
      name: 'Provider-served Slack',
      transport: 'stdio',
      command: 'provider-slack'
    })
    const sourceCalls: Array<{ tool: string; args: unknown }> = []
    sources.set(id, {
      tools: [{ name: 'users_list', description: 'Users', inputSchema: { type: 'object' } }],
      verify: async () => {},
      callTool: async (tool, args) => {
        sourceCalls.push({ tool, args })
        if (tool === 'history') return { ok: false, error: 'rate limited' }
        return { ok: true, result: { via: 'provider-source', tool } }
      }
    })

    const outcome = await connectors.withConnector(id, async (call) => {
      const users = await call('users_list', { limit: 5 })
      const channels = await call('channels_list', undefined)
      const history = await call('history', { channel: 'C1' })
      return { users, channels, history }
    })

    expect(outcome).toEqual({
      users: { ok: true, result: { via: 'provider-source', tool: 'users_list' } },
      channels: { ok: true, result: { via: 'provider-source', tool: 'channels_list' } },
      history: { ok: false, error: 'rate limited' }
    })
    expect(sourceCalls).toEqual([
      { tool: 'users_list', args: { limit: 5 } },
      { tool: 'channels_list', args: undefined },
      { tool: 'history', args: { channel: 'C1' } }
    ])
    expect(sdk.connectedCommands).toEqual([])
    expect(sdk.calledTools).toEqual([])
    expect(sdk.closedCommands).toEqual([])
  })

  it('still opens ONE generic MCP session for a connector without a source and closes it', async () => {
    const connectors = await import('../mcp')
    const id = connectors.addConnector({
      name: 'Generic stdio',
      transport: 'stdio',
      command: 'generic-mcp'
    })

    const outcome = await connectors.withConnector(id, async (call) => {
      const first = await call('read_a', {})
      const failed = await call('explode', {})
      const second = await call('read_b', { page: 2 })
      return { first, failed, second }
    })

    expect(outcome).toEqual({
      first: { ok: true, result: { via: 'generic-mcp', tool: 'read_a' } },
      failed: { ok: false, error: 'generic tool failed' },
      second: { ok: true, result: { via: 'generic-mcp', tool: 'read_b' } }
    })
    expect(sdk.connectedCommands).toEqual(['generic-mcp'])
    expect(sdk.calledTools).toEqual(['read_a', 'explode', 'read_b'])
    expect(sdk.closedCommands).toEqual(['generic-mcp'])
  })

  it('refuses a disabled connector before touching either the source or the transport', async () => {
    const connectors = await import('../mcp')
    const id = connectors.addConnector({
      name: 'Disabled provider',
      transport: 'stdio',
      command: 'provider-disabled'
    })
    let sourceHits = 0
    sources.set(id, {
      tools: [],
      verify: async () => {},
      callTool: async () => {
        sourceHits += 1
        return { ok: true }
      }
    })
    connectors.setConnectorEnabled(id, false)

    await expect(connectors.withConnector(id, async (call) => call('x', {}))).rejects.toThrow(
      'connector disabled'
    )
    expect(sourceHits).toBe(0)
    expect(sdk.connectedCommands).toEqual([])
  })
})
