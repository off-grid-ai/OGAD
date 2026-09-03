// Composition root: the shared MCP connector application over Desktop's SQLite + transport ports.
import { McpConnectorApplicationService } from '@offgrid/models'
import { desktopMcpConnectorPorts, type Connector } from '../mcp'
import { once } from './once'

export const mcpConnectorApplication = once(
  () => new McpConnectorApplicationService<Connector>(desktopMcpConnectorPorts())
)
