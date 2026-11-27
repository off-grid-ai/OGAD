/** The tool shapes a connector offers, shared by MCP and the providers that own their own protocol. */
export interface ConnectorToolDefinition {
  name: string
  description?: string
  inputSchema?: unknown
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
}

export interface ConnectorToolCallResult {
  ok: boolean
  result?: unknown
  error?: string
}

/**
 * A provider-owned connector can verify through its supported protocol while keeping generic MCP
 * discovery disabled. The provider owns execution too, so a published REST-backed tool never falls
 * through to an unavailable preview MCP endpoint.
 */
export interface ConnectorToolSource {
  tools: ConnectorToolDefinition[]
  /** Optional direct authorization owned by the provider, without a remote MCP handshake. */
  authorize?: () => Promise<void>
  verify: () => Promise<void>
  callTool: (tool: string, args: unknown) => Promise<ConnectorToolCallResult>
}
