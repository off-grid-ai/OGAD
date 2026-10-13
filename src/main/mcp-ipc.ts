// Core MCP wiring: basic connector management + the chat tool extension. The Pro
// layer adds CRM ingestion (mcp:ingest / mcp:items) and approval-gating on top.
import { getSecret } from './secrets'
import { ipcMain } from 'electron'
import {
  listConnectors,
  addConnector,
  setConnectorEnabled,
  removeConnector,
  updateConnector,
  cancelConnectorAuthorization,
  testConnector,
  setConnectorSecrets,
  callConnectorTool,
  type NewConnector,
  type ConnectorChanges
} from './mcp'
import { registerToolExtension } from './tools'
import { mcpConnectorToolExtension } from './tools/mcpConnectorToolExtension'

export function setupMcpIpc(): void {
  // Each row says whether it is live-only: read when asked, never synced into memory.
  ipcMain.handle('mcp:list', () =>
    listConnectors().map((c) => ({
      ...c,
      liveOnly: getSecret(`connector:${c.id}:live-only`) === 'true'
    }))
  )
  ipcMain.handle('mcp:add', (_e, c: NewConnector) => addConnector(c))
  ipcMain.handle('mcp:set-enabled', (_e, id: number, enabled: boolean) =>
    setConnectorEnabled(id, enabled)
  )
  ipcMain.handle('mcp:update', (_e, id: number, changes: ConnectorChanges) =>
    updateConnector(id, changes)
  )
  ipcMain.handle('mcp:remove', (_e, id: number) => removeConnector(id))
  ipcMain.handle('mcp:cancel', (_e, id: number) => cancelConnectorAuthorization(id))
  ipcMain.handle('mcp:test', (_e, id: number) => testConnector(id))
  ipcMain.handle('mcp:set-secrets', (_e, id: number, values: Record<string, string>) =>
    setConnectorSecrets(id, values)
  )
  ipcMain.handle('mcp:call', (_e, id: number, tool: string, args: unknown) =>
    callConnectorTool(id, tool, args)
  )

  // Make connector tools available to chat (window.api.toolChat with connectors).
  registerToolExtension(mcpConnectorToolExtension)
}
