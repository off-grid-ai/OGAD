#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type -- executable JavaScript fixture */

// APP-046's only fake: the native llama-server HTTP/SSE boundary. The app owns
// model launch, cancellation, IPC, renderer state, SQLite, and the next turn.

import fs from 'node:fs'
import http from 'node:http'

const args = process.argv.slice(2)
const portFlag = Math.max(args.indexOf('--port'), args.indexOf('-p'))
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 8439
const auditFile = process.env.OFFGRID_APP046_AUDIT_FILE
const sockets = new Set()
const timers = new Set()

const audit = (event) => {
  if (auditFile) fs.appendFileSync(auditFile, `${JSON.stringify(event)}\n`)
}

const delta = (content, finishReason = null) =>
  `data: ${JSON.stringify({ choices: [{ delta: content ? { content } : {}, finish_reason: finishReason }] })}\n\n`

const later = (callback, delayMs) => {
  const timer = setTimeout(() => {
    timers.delete(timer)
    callback()
  }, delayMs)
  timers.add(timer)
  return timer
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ status: 'ok' }))
    return
  }
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'app046-local-model' }] }))
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
    const secondTurn = body.includes('Prove the engine accepts the next prompt.')
    audit({ event: 'completion-started', secondTurn, stream: payload.stream === true })

    // Conversation-title generation uses the same endpoint without streaming.
    // Answer it immediately so the product can proceed to the user's streamed turn.
    if (!payload.stream) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [{ message: { content: 'Stopped stream recovery' } }],
          usage: { total_tokens: 0 }
        })
      )
      audit({ event: 'title-finished' })
      return
    }

    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'close'
    })

    if (secondTurn) {
      response.write(delta('APP-046 engine recovered exactly once.'))
      response.write(delta('', 'stop'))
      response.write('data: [DONE]\n\n')
      response.end()
      audit({ event: 'completion-finished', secondTurn: true })
      return
    }

    response.write(delta('APP-046 partial answer stays visible.'))
    audit({ event: 'partial-sent' })
    const tailTimer = later(() => {
      response.write(delta(' FORBIDDEN TAIL AFTER STOP.'))
      response.write(delta('', 'stop'))
      response.write('data: [DONE]\n\n')
      response.end()
      audit({ event: 'completion-finished', secondTurn: false })
    }, 30_000)
    response.on('close', () => {
      if (response.writableEnded) return
      clearTimeout(tailTimer)
      timers.delete(tailTimer)
      audit({ event: 'completion-cancelled-after-partial' })
    })
  })
})

server.on('connection', (socket) => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
})

server.listen(port, '127.0.0.1', () => {
  audit({ event: 'listening', address: '127.0.0.1', port })
})

const close = () => {
  for (const timer of timers) clearTimeout(timer)
  timers.clear()
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  server.close(() => process.exit(0))
}
process.on('SIGTERM', close)
process.on('SIGINT', close)
