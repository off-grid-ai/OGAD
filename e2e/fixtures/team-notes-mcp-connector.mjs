// A synthetic local MCP server: one read tool listing two notes, one about a person the user deleted.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = new McpServer({ name: 'team-notes', version: '1.0.0' })
server.registerTool(
  'list_notes',
  { description: 'Lists the newest notes in the synthetic team notebook.' },
  async () => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          items: [
            { title: 'Yara Holt', description: 'Asked again about the launch date' },
            { title: 'Orbit roadmap', description: 'Third milestone moved to May' }
          ]
        })
      }
    ]
  })
)
await server.connect(new StdioServerTransport())
