// Composition root: the shared MCP connector application over registered Desktop I/O ports.
import { McpConnectorApplicationService, once } from '@offgrid/models'

type McpConnectorPorts = ConstructorParameters<typeof McpConnectorApplicationService>[0]

let desktopPorts: McpConnectorPorts | null = null

export function registerDesktopMcpConnectorPorts(ports: McpConnectorPorts): void {
  if (desktopPorts) throw new Error('Desktop MCP connector ports are already registered.')
  desktopPorts = ports
}

export const mcpConnectorApplication = once(() => {
  if (!desktopPorts) throw new Error('Desktop MCP connector ports are not registered.')
  return new McpConnectorApplicationService(desktopPorts)
})
