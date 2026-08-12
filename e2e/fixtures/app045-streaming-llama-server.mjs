#!/usr/bin/env node

// APP-045's only fake: the native llama-server executable/HTTP boundary. The
// production app still owns model discovery, process launch, loopback HTTP/SSE,
// preload + IPC, MemoryChat rendering, SQLite persistence, and relaunch.

import fs from 'node:fs'
import http from 'node:http'

const args = process.argv.slice(2)
const portFlag = Math.max(args.indexOf('--port'), args.indexOf('-p'))
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 8439
const auditFile = process.env.OFFGRID_APP045_AUDIT_FILE
const timers = new Set()
const sockets = new Set()

// Plain JavaScript fixtures are linted with the TypeScript rules.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const audit = (event) => {
  if (!auditFile) return
  fs.appendFileSync(auditFile, `${JSON.stringify(event)}\n`)
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const delta = (content, finishReason = null) =>
  `data: ${JSON.stringify({ choices: [{ delta: content ? { content } : {}, finish_reason: finishReason }] })}\n\n`

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const later = (callback, delayMs) => {
  const timer = setTimeout(() => {
    timers.delete(timer)
    callback()
  }, delayMs)
  timers.add(timer)
}

const server = http.createServer((request, response) => {
  audit({
    event: 'request',
    method: request.method,
    url: request.url,
    host: request.headers.host,
    remoteAddress: request.socket.remoteAddress
  })

  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ status: 'ok' }))
    return
  }
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'app045-local-model' }] }))
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
    audit({ event: 'completion', stream: payload.stream === true })
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'close'
    })

    // Leave an observable interval between chunks. A rendered assertion must see
    // the first phrase while generation is still active before the final text can exist.
    response.write(delta('APP-045 local first chunk'))
    later(() => {
      response.write(delta(' arrives, then completes offline.'))
      response.write(delta('', 'stop'))
      response.write('data: [DONE]\n\n')
      response.end()
    }, 2_000)
  })
})

server.on('connection', (socket) => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
})

server.listen(port, '127.0.0.1', () => {
  audit({ event: 'listening', address: '127.0.0.1', port, args })
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const close = () => {
  for (const timer of timers) clearTimeout(timer)
  timers.clear()
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  server.close(() => process.exit(0))
}
process.on('SIGTERM', close)
process.on('SIGINT', close)
