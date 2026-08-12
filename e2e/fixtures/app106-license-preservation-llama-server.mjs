#!/usr/bin/env node

/**
 * Native llama-server boundary for APP-106.
 *
 * The activation path remains completely production: this executable only replaces
 * the uncontrollable local model binary so a chat can be created through the real
 * renderer, IPC, persistence, and streaming stack before the licence relaunch.
 */
import http from 'node:http'

const args = process.argv.slice(2)
const portIndex = args.indexOf('--port')
const port = Number(portIndex >= 0 ? args[portIndex + 1] : 8439)
const answer = 'APP-106 profile survives activation.'
const sockets = new Set()

// Plain JavaScript fixtures are linted with the TypeScript rules.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    json(response, 200, { status: 'ok' })
    return
  }

  if (request.method === 'GET' && request.url === '/v1/models') {
    json(response, 200, {
      object: 'list',
      data: [{ id: 'app106-local-model', object: 'model', owned_by: 'local' }]
    })
    return
  }

  if (request.method === 'POST' && request.url === '/v1/chat/completions') {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      let stream = true
      try {
        stream = JSON.parse(body).stream !== false
      } catch {
        json(response, 400, { error: { message: 'Invalid JSON' } })
        return
      }

      if (!stream) {
        json(response, 200, {
          id: 'app106-completion',
          object: 'chat.completion',
          choices: [
            { index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }
          ]
        })
        return
      }

      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      response.write(
        `data: ${JSON.stringify({
          id: 'app106-completion',
          object: 'chat.completion.chunk',
          choices: [
            { index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }
          ]
        })}\n\n`
      )
      response.write(
        `data: ${JSON.stringify({
          id: 'app106-completion',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
        })}\n\n`
      )
      response.end('data: [DONE]\n\n')
    })
    return
  }

  json(response, 404, { error: { message: 'Not found' } })
})

server.on('connection', (socket) => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const stop = () => {
  server.close(() => process.exit(0))
  for (const socket of sockets) socket.destroy()
  setTimeout(() => process.exit(0), 1_000).unref()
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)
server.listen(port, '127.0.0.1')
