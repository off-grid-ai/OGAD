#!/usr/bin/env node

// The native llama-server boundary for paired-browser chat specs. Every request body is written
// to OFFGRID_BROWSER_CHAT_LOG. "Count slowly" streams numbered words until the client goes away,
// so a spec can stop a run midway; anything else gets a short answer that names the question.

import fs from 'node:fs'
import http from 'node:http'

const args = process.argv.slice(2)
const portFlag = Math.max(args.indexOf('--port'), args.indexOf('-p'))
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 8439
const log = process.env.OFFGRID_BROWSER_CHAT_LOG

const delta = (content, finishReason = null) =>
  `data: ${JSON.stringify({ choices: [{ delta: content ? { content } : {}, finish_reason: finishReason }] })}\n\n`

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((part) => part?.type === 'text')
          .map((part) => part.text)
          .join('\n')
      : ''

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ status: 'ok' }))
    return
  }
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'browser-chat-model' }] }))
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
    const users = (payload.messages ?? []).filter((message) => message.role === 'user')
    const last = textOf(users[users.length - 1]?.content)
    if (last.includes('Count slowly') && !last.includes('The user asked:')) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      let n = 0
      const timer = setInterval(() => response.write(delta(`tok${++n} `)), 150)
      response.on('close', () => clearInterval(timer))
      return
    }
    const text = `Browser answer: ${last.split('\n').at(-1).slice(0, 60)}`
    if (!payload.stream) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }]
        })
      )
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write(delta(text))
    response.write(delta('', 'stop'))
    response.end('data: [DONE]\n\n')
  })
})

server.listen(port, '127.0.0.1')
const shutdown = () => server.close(() => process.exit(0))
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
