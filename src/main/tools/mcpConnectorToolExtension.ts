// MCP connectors as a chat tool extension (core). Registered into the chat tool
// loop via registerToolExtension. Connector tools are exposed to the model
// namespaced as `mcp__<id>__<tool>` and executed directly.
//
// Open-core seam: mutating tools first offer themselves to the shared
// `actions:proposeApproval` hook via proposeActionApproval — Pro registers it to
// route writes through its approval queue. In the free build no hook is registered,
// so connector tools just run.

import type { ToolExtension } from '../tools'
import { listConnectors, fetchTools, callConnectorTool, setConnectorStatus } from '../mcp'
import { proposeActionApproval, shouldGate, type ActionApprovalRequest } from '../actions/approval'
import {
  MCP_TOOL_PREFIX,
  buildConnectorToolSchema,
  formatConnectorToolResult,
  riskOf,
  type ConnectorToolDefinition
} from './mcpConnectorToolExtension-logic'

interface ConnectorCallResult {
  ok: boolean
  result?: unknown
  error?: string
}

export interface McpConnectorToolBoundary {
  fetchTools: (connectorId: number) => Promise<ConnectorToolDefinition[]>
  callTool: (
    connectorId: number,
    tool: string,
    args: Record<string, unknown>
  ) => Promise<ConnectorCallResult>
  proposeApproval: (request: ActionApprovalRequest) => boolean | undefined
}

const productionBoundary: McpConnectorToolBoundary = {
  fetchTools,
  callTool: callConnectorTool,
  proposeApproval: proposeActionApproval
}

export class McpConnectorToolExtension implements ToolExtension {
  id = 'mcp-connectors'
  private byName = new Map<string, { id: number; tool: string; connector: string }>()

  constructor(private readonly boundary: McpConnectorToolBoundary = productionBoundary) {}

  async schemas(): Promise<unknown[]> {
    this.byName.clear()
    const out: unknown[] = []
    try {
      const enabled = listConnectors().filter((c) => c.enabled)
      // Load every connector's tools CONCURRENTLY (each bounded by fetchTools'
      // timeout) so N connectors don't add up serially on the chat turn.
      const loaded = await Promise.all(
        enabled.map(async (c) => {
          try {
            return { c, tools: await this.boundary.fetchTools(c.id) }
          } catch (e) {
            // A connector shown "connected" whose token expired / server is down
            // must NOT silently vanish: mark it errored so the UI prompts a
            // reconnect, rather than the model quietly losing its tools.
            console.error('[mcp-ext] fetchTools', c.name, e)
            setConnectorStatus(c.id, 'error', e instanceof Error ? e.message : String(e))
            return {
              c,
              tools: [] as { name: string; description?: string; inputSchema?: unknown }[]
            }
          }
        })
      )
      for (const { c, tools } of loaded) {
        for (const t of tools) {
          const schema = buildConnectorToolSchema(c, t)
          const fnName = schema.function.name
          this.byName.set(fnName, { id: c.id, tool: t.name, connector: c.name })
          out.push(schema)
        }
      }
    } catch (e) {
      console.error('[mcp-ext] schemas', e)
    }
    return out
  }

  canHandle(name: string): boolean {
    return name.startsWith(MCP_TOOL_PREFIX)
  }

  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const meta = this.byName.get(name)
    if (!meta) return `Error: unknown connector tool ${name}`
    // Pro can intercept mutating tools for approval; returns true if it queued them.
    const risk = riskOf(meta.tool)
    if (shouldGate(risk)) {
      const queued = this.boundary.proposeApproval({
        kind: 'mcp',
        title: `${meta.tool} via ${meta.connector}`,
        detail: `Requested from chat. Arguments: ${JSON.stringify(args)}`,
        risk,
        connectorId: meta.id,
        connector: meta.connector,
        tool: meta.tool,
        args,
        source: 'chat'
      })
      if (queued) {
        return `Queued for the user's approval — "${meta.tool}" on ${meta.connector} will run only after they approve it. Do not assume it has happened; tell the user it's pending approval.`
      }
    }
    try {
      const r = await this.boundary.callTool(meta.id, meta.tool, args)
      if (!r.ok) return `Error: ${r.error ?? 'connector call failed'}`
      return formatConnectorToolResult(r.result)
    } catch (e) {
      return `Error: ${(e as Error).message}`
    }
  }
}

export const mcpConnectorToolExtension = new McpConnectorToolExtension()
