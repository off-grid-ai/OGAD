// MCP connectors as a chat tool extension (core). Registered into the chat tool
// loop via registerToolExtension. Connector tools are exposed to the model
// namespaced as `mcp__<id>__<tool>` and executed directly.
//
// Open-core seam: write tools first offer themselves to the `mcp:proposeApproval`
// hook — Pro registers it to route writes through its approval queue. In the free
// build no hook is registered, so connector tools just run.

import type { ToolExtension } from '../tools';
import { listConnectors, fetchTools, callConnectorTool } from '../mcp';
import { callHook } from '../bootstrap/hookRegistry';

const MCP_PREFIX = 'mcp__';

function isActionTool(tool: string): boolean {
  return !/^(list|get|search|read|fetch|whoami|describe)[_-]/i.test(tool);
}

class McpConnectorToolExtension implements ToolExtension {
  id = 'mcp-connectors';
  private byName = new Map<string, { id: number; tool: string; connector: string }>();

  async schemas(): Promise<unknown[]> {
    this.byName.clear();
    const out: unknown[] = [];
    try {
      const enabled = listConnectors().filter((c) => c.enabled);
      for (const c of enabled) {
        let tools: { name: string; description?: string; inputSchema?: unknown }[] = [];
        try { tools = await fetchTools(c.id); } catch (e) { console.error('[mcp-ext] fetchTools', c.name, e); continue; }
        for (const t of tools) {
          const fnName = `${MCP_PREFIX}${c.id}__${t.name}`;
          this.byName.set(fnName, { id: c.id, tool: t.name, connector: c.name });
          out.push({
            type: 'function',
            function: {
              name: fnName,
              description: `[${c.name}] ${t.description ?? t.name}`,
              parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
            },
          });
        }
      }
    } catch (e) {
      console.error('[mcp-ext] schemas', e);
    }
    return out;
  }

  canHandle(name: string): boolean {
    return name.startsWith(MCP_PREFIX);
  }

  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const meta = this.byName.get(name);
    if (!meta) return `Error: unknown connector tool ${name}`;
    // Pro can intercept writes for approval; returns true if it queued the action.
    if (isActionTool(meta.tool)) {
      const queued = callHook<boolean>('mcp:proposeApproval', {
        title: `${meta.tool} via ${meta.connector}`,
        detail: `Requested from chat. Arguments: ${JSON.stringify(args)}`,
        connector: meta.connector,
        tool: meta.tool,
        args,
        source: 'chat',
      });
      if (queued) {
        return `Queued for the user's approval — "${meta.tool}" on ${meta.connector} will run only after they approve it. Do not assume it has happened; tell the user it's pending approval.`;
      }
    }
    try {
      const r = await callConnectorTool(meta.id, meta.tool, args);
      if (!r.ok) return `Error: ${r.error ?? 'connector call failed'}`;
      const o = typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
      return o.length > 8000 ? o.slice(0, 8000) + '… (truncated)' : o;
    } catch (e) {
      return `Error: ${(e as Error).message}`;
    }
  }
}

export const mcpConnectorToolExtension = new McpConnectorToolExtension();
