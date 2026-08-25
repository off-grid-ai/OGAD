import type { ActionRisk } from '../actions/approval'

export const MCP_TOOL_PREFIX = 'mcp__'

export interface ConnectorToolDefinition {
  name: string
  description?: string
  inputSchema?: unknown
}

export interface ConnectorToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: unknown
  }
}

export function isActionTool(tool: string): boolean {
  return !/^(list|get|search|read|fetch|whoami|describe)[_-]/i.test(tool)
}

/** Classify a connector tool for the shared approval seam. MCP gives us only the
 *  tool name, so read-verb tools are reads and everything else is a mutate — we
 *  cannot tell an irreversible connector call from a recoverable one by name, so
 *  we gate conservatively as mutate rather than guessing 'irreversible'. */
export function riskOf(tool: string): ActionRisk {
  return isActionTool(tool) ? 'mutate' : 'read'
}

export function buildConnectorToolSchema(
  connector: { id: number; name: string },
  tool: ConnectorToolDefinition
): ConnectorToolSchema {
  return {
    type: 'function',
    function: {
      name: `${MCP_TOOL_PREFIX}${connector.id}__${tool.name}`,
      description: `[${connector.name}] ${tool.description ?? tool.name}`,
      parameters: (tool.inputSchema as Record<string, unknown> | undefined) ?? {
        type: 'object',
        properties: {}
      }
    }
  }
}

export function formatConnectorToolResult(result: unknown): string {
  const output = typeof result === 'string' ? result : JSON.stringify(result)
  return output.length > 8000 ? `${output.slice(0, 8000)}… (truncated)` : output
}
