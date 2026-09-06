/**
 * Shared owns the complete connector connection and retry transaction. SQLite and encrypted
 * credentials are real Desktop adapters; only the external MCP client is controlled here.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-connector-connection-'))
const transport = vi.hoisted(() => ({ attempts: 0 }))

vi.mock('electron', () => ({
  app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => true,
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
    async connect(): Promise<void> {}
    async listTools(): Promise<{ tools: Array<{ name: string }> }> {
      transport.attempts += 1
      if (transport.attempts === 1) throw new Error('network fetch failed')
      return { tools: [{ name: 'search' }] }
    }
    async close(): Promise<void> {}
  }
}))

afterAll(async () => {
  const { getDB } = await import('../database')
  getDB().close()
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

describe('Desktop connector connection adapter', () => {
  it('persists through Desktop ports, cleans a failed attempt, and returns the recovered Shared snapshot', async () => {
    const connectors = await import('../mcp')
    const { listSecretKeys } = await import('../secrets')
    const command = {
      key: 'local-search',
      connector: {
        name: 'Local Search',
        transport: 'stdio' as const,
        command: 'external-search',
        credentialKeys: ['token']
      },
      credentials: { token: 'device-secret' }
    }

    const failed = await connectors.connectConnector(command)
    expect(failed).toEqual({
      result: { status: 'failed', error: 'Could not reach the server.' },
      snapshot: {
        connections: [
          { key: 'local-search', phase: 'failed', error: 'Could not reach the server.' }
        ]
      }
    })
    expect(connectors.listConnectors()).toEqual([])
    expect(listSecretKeys()).toEqual([])

    const recovered = await connectors.connectConnector(command)
    expect(recovered.result).toEqual({
      status: 'connected',
      connectorId: expect.any(Number),
      tools: [{ name: 'search' }]
    })
    expect(recovered.snapshot).toEqual({
      connections: [
        {
          key: 'local-search',
          phase: 'connected',
          connectorId: recovered.result.status === 'connected' ? recovered.result.connectorId : -1
        }
      ]
    })
    expect(connectors.listConnectors()).toHaveLength(1)
    expect(listSecretKeys()).toEqual([
      `connector:${recovered.result.status === 'connected' ? recovered.result.connectorId : -1}:token`
    ])
  })
})
