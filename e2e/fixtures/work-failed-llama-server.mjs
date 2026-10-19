#!/usr/bin/env node

// Native-model boundary for the failed-work E2E. The app talks to this executable over llama.cpp's
// OpenAI-compatible HTTP/SSE contract; everything above it is real. First turn: the model asks to
// read a page on a port nothing listens on, so the real read_url tool fails. Next turn: it answers.

import http from 'node:http'

const args = process.argv.slice(2)
const portFlag = Math.max(args.indexOf('--port'), args.indexOf('-p'))
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 8439

// Plain executable JavaScript cannot carry a TypeScript return annotation.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const delta = (payload) => `data: ${JSON.stringify({ choices: [{ delta: payload }] })}\n\n`

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ status: 'ok' }))
    return
  }
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'e2e-work-failed-model' }] }))
    return
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404)
    response.end()
    return
  }

  let body = ''
  request.on('data', (chunk) => {
    body += chunk
  })
  request.on('end', () => {
    const payload = JSON.parse(body)
    response.writeHead(200, {
      'Content-Type': payload.stream ? 'text/event-stream' : 'application/json'
    })
    if (!payload.stream) {
      response.end(
        JSON.stringify({
          choices: [{ message: { content: 'Reading a page' } }],
          usage: { total_tokens: 0 }
        })
      )
      return
    }
    const toolResultArrived = (payload.messages ?? []).some((message) => message.role === 'tool')
    if (!toolResultArrived) {
      response.write(
        delta({
          tool_calls: [
            {
              index: 0,
              id: 'call_read_url',
              type: 'function',
              function: {
                name: 'read_url',
                arguments: JSON.stringify({ url: 'http://127.0.0.1:9/' })
              }
            }
          ]
        })
      )
    } else {
      response.write(delta({ content: 'I could not open that page.' }))
    }
    response.write('data: [DONE]\n\n')
    response.end()
  })
})

server.listen(port, '127.0.0.1')

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const close = () => server.close(() => process.exit(0))
process.on('SIGTERM', close)
process.on('SIGINT', close)
