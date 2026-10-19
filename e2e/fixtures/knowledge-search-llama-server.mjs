#!/usr/bin/env node

// The native llama-server boundary for the project-knowledge spec. Every request body is written
// to OFFGRID_KNOWLEDGE_MODEL_LOG. It behaves like a model that searches only when it must: a
// question about a station's keeper codeword calls search_knowledge_base (when offered and not yet
// answered) and then quotes the codeword the search returned; anything else is answered plainly.

import fs from 'node:fs'
import http from 'node:http'

const args = process.argv.slice(2)
const portFlag = Math.max(args.indexOf('--port'), args.indexOf('-p'))
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 8439
const log = process.env.OFFGRID_KNOWLEDGE_MODEL_LOG

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((part) => part?.type === 'text')
          .map((part) => part.text)
          .join('\n')
      : ''

const delta = (payload) => `data: ${JSON.stringify({ choices: [{ delta: payload }] })}\n\n`

const reply = (response, stream, message) => {
  if (!stream) {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', ...message }, finish_reason: 'stop' }]
      })
    )
    return
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  response.write(
    message.tool_calls
      ? delta({ tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) })
      : delta({ content: message.content })
  )
  response.end('data: [DONE]\n\n')
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ status: 'ok' }))
    return
  }
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'knowledge-model' }] }))
    return
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404)
    response.end()
    return
  }
  let body = ''
  request.setEncoding('utf8')
  request.on('data', (chunk) => {
    body += chunk
  })
  request.on('end', () => {
    if (log) fs.appendFileSync(log, `${body}\n`)
    const payload = JSON.parse(body)
    const messages = payload.messages ?? []
    const users = messages.filter((message) => message.role === 'user')
    const last = textOf(users[users.length - 1]?.content)
    const toolResult = messages.find((message) => message.role === 'tool')
    const search = (payload.tools ?? []).some(
      (tool) => tool.function?.name === 'search_knowledge_base'
    )
    if (toolResult) {
      const found = textOf(toolResult.content).match(/[A-Z]+-\d+/)?.[0] ?? 'not found'
      reply(response, payload.stream === true, { content: `The codeword is ${found}.` })
      return
    }
    if (search && last.includes('keeper codeword') && !last.includes('The user asked:')) {
      reply(response, payload.stream === true, {
        content: '',
        tool_calls: [
          {
            id: 'call_search_knowledge_base',
            type: 'function',
            function: {
              name: 'search_knowledge_base',
              arguments: JSON.stringify({ query: last })
            }
          }
        ]
      })
      return
    }
    reply(response, payload.stream === true, { content: 'Plain answer.' })
  })
})

server.listen(port, '127.0.0.1')
const shutdown = () => server.close(() => process.exit(0))
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
