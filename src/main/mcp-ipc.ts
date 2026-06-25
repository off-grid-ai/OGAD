// Core MCP wiring: basic connector management + the chat tool extension. The Pro
// layer adds CRM ingestion (mcp:ingest / mcp:items) and approval-gating on top.
import { ipcMain } from 'electron';
import { listConnectors, addConnector, setConnectorEnabled, removeConnector, testConnector, callConnectorTool, type NewConnector } from './mcp';
import { registerToolExtension } from './tools';
import { mcpConnectorToolExtension } from './tools/mcpConnectorToolExtension';

export function setupMcpIpc(): void {
  ipcMain.handle('mcp:list', () => listConnectors());
  ipcMain.handle('mcp:add', (_e, c: NewConnector) => addConnector(c));
  ipcMain.handle('mcp:set-enabled', (_e, id: number, enabled: boolean) => setConnectorEnabled(id, enabled));
  ipcMain.handle('mcp:remove', (_e, id: number) => removeConnector(id));
  ipcMain.handle('mcp:test', (_e, id: number) => testConnector(id));
  ipcMain.handle('mcp:call', (_e, id: number, tool: string, args: unknown) => callConnectorTool(id, tool, args));

  // Make connector tools available to chat (window.api.toolChat with connectors).
  registerToolExtension(mcpConnectorToolExtension);
}
