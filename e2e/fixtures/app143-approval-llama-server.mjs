#!/usr/bin/env node

// APP-143's model-runtime boundary. It selects the connector tool exposed by the real MCP
// extension, then reports the real tool result on the next model round. Everything above this
// OpenAI-compatible boundary remains production code.

import http from 'node:http'

const args = process.argv.slice(2)
const portFlag = Math.max(args.indexOf('--port'), args.indexOf('-p'))
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 8439

const delta = (content, finishReason = null) =>
  `data: ${JSON.stringify({ choices: [{ delta: content ? { content } : {}, finish_reason: finishReason }] })}\n\n`

const connectorTool = (body) => {
  const match = body.match(/mcp__\d+__create_external_task/)
  return match?.[0]
}

const stream = (response, text) => {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'close'
  })
  for (const piece of text.match(/.{1,32}/gs) ?? []) response.write(delta(piece))
  response.write(delta('', 'stop'))
  response.write('data: [DONE]\n\n')
  response.end()
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ status: 'ok' }))
    return
  }
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'app143-local-model' }] }))
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
    const payload = JSON.parse(body)
    if (!payload.stream) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [{ message: { content: 'APP-143 guarded approval' } }],
          usage: { total_tokens: 0 }
        })
      )
      return
    }
    if (payload.response_format?.type === 'json_schema') {
      stream(response, JSON.stringify({ intent: 'chat', urls: [] }))
      return
    }

    const tool = connectorTool(body)
    if (tool && !body.includes('Created external task')) {
      stream(
        response,
        `<tool_call>${JSON.stringify({
          name: tool,
          arguments: {
            title: 'Ship guarded approval journey',
            project: 'Desktop P0'
          }
        })}</tool_call>`
      )
      return
    }
    stream(response, 'Created the external task once and verified the connector result.')
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`app143 fake llama-server listening on ${port}`)
})
