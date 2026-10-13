// A synthetic local MCP server for the accounts lifecycle spec: one read tool, synthetic data.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'accounts-lifecycle-notes', version: '1.0.0' })
server.registerTool(
  'lookup_note',
  { description: 'Finds a note in the synthetic notebook.', inputSchema: { title: z.string() } },
  async ({ title }) => ({ content: [{ type: 'text', text: `Synthetic note: ${title}` }] })
)
await server.connect(new StdioServerTransport())
