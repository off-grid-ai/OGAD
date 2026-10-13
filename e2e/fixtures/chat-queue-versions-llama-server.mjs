#!/usr/bin/env node
// Only the native model HTTP/SSE boundary is replaced. Electron, IPC, queue,
// cancellation, message storage, and response navigation run as shipped.
import fs from 'node:fs'
import http from 'node:http'

const args = process.argv.slice(2)
const portFlag = Math.max(args.indexOf('--port'), args.indexOf('-p'))
const port = Number(args[portFlag + 1])
if (portFlag < 0 || !Number.isInteger(port)) throw new Error('The app must choose the model port')
const auditFile = process.env.OFFGRID_CHAT_CONTROLS_AUDIT_FILE
const sockets = new Set()
const timers = new Set()
const attempts = new Map()
const audit = (event) => fs.appendFileSync(auditFile, `${JSON.stringify(event)}\n`)
const delta = (content, finishReason = null) =>
  `data: ${JSON.stringify({ choices: [{ delta: content ? { content } : {}, finish_reason: finishReason }] })}\n\n`
const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ status: 'ok' }))
    return
  }
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'chat-controls-local-model' }] }))
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
      response.end(JSON.stringify({ choices: [{ message: { content: 'Chat controls' } }] }))
      return
    }
    const message = payload.messages.findLast((item) => item.role === 'user')
    const prompt =
      typeof message?.content === 'string'
        ? message.content
        : message?.content
            ?.filter((item) => item.type === 'text')
            .map((item) => item.text)
            .join('\n')
    const attempt = (attempts.get(prompt) ?? 0) + 1
    attempts.set(prompt, attempt)
    audit({
      event: 'request',
      prompt,
      attempt,
      messages: payload.messages
        .filter((item) => item.role === 'user' || item.role === 'assistant')
        .map((item) => ({
          role: item.role,
          content:
            typeof item.content === 'string'
              ? item.content
              : item.content
                  .filter((part) => part.type === 'text')
                  .map((part) => part.text)
                  .join('\n')
        }))
    })
    if (prompt === 'Keep the saved answer after failure.' && attempt === 2) {
      response.writeHead(503, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Synthetic model unavailable.' } }))
      return
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'close'
    })
    const finish = (answer) => {
      response.write(delta(answer))
      response.write(delta('', 'stop'))
      response.end('data: [DONE]\n\n')
    }
    if (prompt === 'Finish while I prepare another chat.') {
      response.write(delta('The background reply started.'))
      const timer = setTimeout(() => {
        timers.delete(timer)
        finish(' The background reply is complete.')
      }, 5000)
      timers.add(timer)
      return
    }
    if (prompt === 'Finish after I reopen Chat.') {
      response.write(delta('The first reply is still running.'))
      const timer = setTimeout(() => {
        timers.delete(timer)
        finish(' The reopened reply is complete.')
      }, 10_000)
      timers.add(timer)
      return
    }
    const interruptedRetry = prompt === 'Keep the saved answer during retry.' && attempt === 2
    if (prompt === 'Hold this reply open.' || interruptedRetry) {
      response.write(
        delta(
          interruptedRetry
            ? 'The replacement reply is still running.'
            : 'The first reply is still running.'
        )
      )
      const timer = setTimeout(() => {
        timers.delete(timer)
        finish(' UNEXPECTED UNINTERRUPTED TAIL.')
      }, 30_000)
      timers.add(timer)
      response.on('close', () => {
        clearTimeout(timer)
        timers.delete(timer)
        if (!response.writableEnded) audit({ event: 'cancelled', prompt })
      })
      return
    }
    const answers = {
      'Send this ahead of the queue.': 'The urgent reply is complete.',
      'Queue this first.': 'The first queued reply is complete.',
      'Queue this second.': 'The second queued reply is complete.',
      'Keep each response version.': `Original answer version ${attempt}.`,
      'Keep the edited response too.': 'Edited answer version 4.',
      'Add a later turn.': 'The later answer will be removed by the edit.',
      'Keep the saved answer during retry.': 'The saved answer remains available.',
      'Keep the saved answer after failure.': 'The saved answer before failure remains available.'
    }
    finish(answers[prompt] ?? `Unexpected prompt: ${String(prompt)}`)
  })
})
server.on('connection', (socket) => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
})
server.listen(port, '127.0.0.1')
const close = () => {
  for (const timer of timers) clearTimeout(timer)
  for (const socket of sockets) socket.destroy()
  server.close(() => process.exit(0))
}
process.on('SIGTERM', close)
process.on('SIGINT', close)
