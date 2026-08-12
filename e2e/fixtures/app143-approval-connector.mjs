import fs from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const executionLog = process.argv[2]
if (!executionLog) throw new Error('APP-143 execution log path is required')

const server = new McpServer({ name: 'app143-approval-boundary', version: '1.0.0' })

server.registerTool(
  'create_external_task',
  {
    description: 'Creates one task in the synthetic external system.',
    inputSchema: {
      title: z.string(),
      project: z.string()
    }
  },
  async ({ title, project }) => {
    const execution = { title, project }
    fs.appendFileSync(executionLog, `${JSON.stringify(execution)}\n`)
    return {
      content: [
        {
          type: 'text',
          text: `Created external task "${title}" in ${project}`
        }
      ]
    }
  }
)

await server.connect(new StdioServerTransport())
