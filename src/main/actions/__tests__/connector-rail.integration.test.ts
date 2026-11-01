// A connector action is executed only when the tool did it. The connector list, the MCP client
// transport and the rail are real; the connector is a stdio MCP server (a Node script) that
// answers one tool normally and reports failure (MCP `isError`) from another.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { ActionRecord } from '@offgrid/use'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-connector-rail-'))
const previousDataDir = process.env.OFFGRID_DATA_DIR
process.env.OFFGRID_DATA_DIR = profile

vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.OFFGRID_DATA_DIR,
    isPackaged: false,
    getAppPath: () => process.cwd()
  },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: async () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { makeConnectorRailExecutor } from '../connector-rail'
import { addConnector, callConnectorTool } from '../../mcp'

const resolved = require.resolve('@modelcontextprotocol/sdk/package.json')
const sdk = resolved.slice(
  0,
  resolved.indexOf('@modelcontextprotocol/sdk') + '@modelcontextprotocol/sdk'.length
)
const SERVER = `
const { McpServer } = require(${JSON.stringify(path.join(sdk, 'dist/cjs/server/mcp.js'))})
const { StdioServerTransport } = require(${JSON.stringify(path.join(sdk, 'dist/cjs/server/stdio.js'))})
const server = new McpServer({ name: 'test-tasks', version: '1.0.0' })
server.tool('create_task', async () => ({ content: [{ type: 'text', text: 'Created task 7.' }] }))
server.tool('delete_task', async () => ({
  isError: true,
  content: [{ type: 'text', text: 'Task 7 is locked and was not deleted.' }]
}))
server.connect(new StdioServerTransport())
`
const script = path.join(profile, 'server.cjs')
fs.writeFileSync(script, SERVER)

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDataDir
  fs.rmSync(profile, { recursive: true, force: true })
})

const action = (connectorId: number, tool: string): ActionRecord =>
  ({ args: { connectorId, tool, args: {} } }) as unknown as ActionRecord

describe('connector rail', () => {
  it('records an executed action only when the tool did not report failure', async () => {
    const connectorId = addConnector({
      name: 'Tasks',
      transport: 'stdio',
      command: 'node',
      args: [script]
    })
    const execute = makeConnectorRailExecutor(callConnectorTool)

    await expect(execute(action(connectorId, 'create_task'))).resolves.toMatchObject({ ok: true })
    // The server answered, and said it did not act: the action failed, with its reason.
    await expect(execute(action(connectorId, 'delete_task'))).resolves.toEqual({
      ok: false,
      detail: 'Task 7 is locked and was not deleted.'
    })
  })
})
