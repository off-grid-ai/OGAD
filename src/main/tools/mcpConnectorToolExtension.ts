// MCP connectors as a chat tool extension (core). Registered into the chat tool
// loop via registerToolExtension. Connector tools are exposed to the model
// namespaced as `mcp__<id>__<tool>`.
//
// Reads execute through the connector transport. Chat mutations use the durable
// action engine. Outside-Chat Actions keeps its separate approval owner.

import type { ToolContext, ToolExtension } from '../tools'
import { listConnectors, fetchTools, callConnectorTool, setConnectorStatus } from '../mcp'
import { shouldGate } from '../actions/approval'
import { getActionsRuntime } from '../actions/use-runtime'
import {
  runChatConnectorAction,
  type ChatConnectorActionsPort,
  type ChatConnectorExecution
} from '../actions/chat-connector-action'
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
  actions?: ChatConnectorActionsPort
}

const productionBoundary: McpConnectorToolBoundary = {
  fetchTools,
  callTool: callConnectorTool,
  get actions(): ChatConnectorActionsPort {
    return getActionsRuntime()
  }
}

function formatChatConnectorExecution(
  execution: ChatConnectorExecution,
  meta: { tool: string; connector: string }
): string {
  switch (execution.kind) {
    case 'unavailable':
      return 'Error: this connector action needs the on-device action engine, which is not available. No approval was created.'
    case 'refused':
      return `Error: the connector action was refused: ${execution.reason}`
    case 'deduped':
      return `That exact connector action is already in flight — not starting a duplicate. Action reference: ${execution.actionId}.`
    case 'parked':
      return `Error: the action engine held this Chat connector action instead of starting it. No approval was created. Action reference: ${execution.actionId}.`
    case 'running':
      return `"${meta.tool}" on ${meta.connector} is running now. It does NOT need approval. Action reference: ${execution.actionId}.`
    case 'finished': {
      const outcome = execution.outcome
      if (outcome.outcome === 'poisoned') {
        return `Error: ${outcome.error}. Action reference: ${execution.actionId}.`
      }
      if (outcome.outcome === 'rejected') {
        return `The connector action was declined and did not run. Action reference: ${execution.actionId}.`
      }
      if (outcome.outcome === 'edited') {
        return `Error: the action engine unexpectedly held this Chat connector action for editing. No approval was created. Action reference: ${execution.actionId}.`
      }
      const detail = outcome.record.attemptLog.at(-1)?.detail
      if (outcome.outcome === 'needs_help') {
        return `The connector action could not be confirmed${detail ? `: ${detail}` : '.'} Action reference: ${execution.actionId}.`
      }
      return `${detail || 'Connector action completed.'} Action reference: ${execution.actionId}.`
    }
  }
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

  async execute(
    name: string,
    args: Record<string, unknown>,
    context?: ToolContext
  ): Promise<string> {
    const meta = this.byName.get(name)
    if (!meta) return `Error: unknown connector tool ${name}`
    const risk = riskOf(meta.tool)
    if (shouldGate(risk)) {
      const execution = await runChatConnectorAction(this.boundary.actions, {
        connectorId: meta.id,
        connector: meta.connector,
        tool: meta.tool,
        args,
        sourceRef: context?.conversationId
      })
      return formatChatConnectorExecution(execution, meta)
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
