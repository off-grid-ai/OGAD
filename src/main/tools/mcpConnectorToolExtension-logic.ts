import type { McpToolDescriptor } from '@offgrid/models'

export const MCP_TOOL_PREFIX = 'mcp__'

export type ConnectorToolDefinition = McpToolDescriptor

export interface ConnectorToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: unknown
  }
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
