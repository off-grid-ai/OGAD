#!/usr/bin/env node

// Native-model boundary for the Ask pane E2E. The app starts this executable through the real
// LLMService and talks to it over llama.cpp's OpenAI-compatible HTTP contract; everything above it
// (IPC, the chat queue, the renderer) is the app's own.
//
// It answers like a model would, except that a question containing "drop this one" gets a server
// error, so the spec can see the failed state. Like a model whose chat template enforces it, it
// refuses two user turns in a row. Every request's role order is appended to requests.jsonl beside
// this file, so the spec can read what the app actually sent.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const args = process.argv.slice(2)
// The Linux engine probe asks for a GPU first; answer it like a Vulkan build and exit.
if (args.includes('--list-devices')) {
  process.stdout.write('Available devices:\n  Vulkan0: Fake GPU (8192 MiB, 8000 MiB free)\n')
  process.exit(0)
}
const portFlag = Math.max(args.indexOf('--port'), args.indexOf('-p'))
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 8439
const log = path.join(path.dirname(process.argv[1]), 'requests.jsonl')

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ status: 'ok' }))
    return
  }
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'e2e-guide-model' }] }))
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
    const messages = payload.messages ?? []
    const roles = messages.map((m) => m.role)
    fs.appendFileSync(log, JSON.stringify({ roles }) + '\n')
    const last = messages.at(-1)?.content ?? ''
    const text = typeof last === 'string' ? last : JSON.stringify(last)
    const twoUsers = roles.some((role, i) => role === 'user' && roles[i + 1] === 'user')
    if (twoUsers || text.includes('drop this one')) {
      response.writeHead(500, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Conversation roles must alternate' } }))
      return
    }
    const answer = `You asked: ${text}. Off Grid AI runs on this computer.`
    if (payload.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`)
      response.write('data: [DONE]\n\n')
      response.end()
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(
      JSON.stringify({
        choices: [{ message: { content: answer } }],
        usage: { total_tokens: 0 }
      })
    )
  })
})

server.listen(port, '127.0.0.1')

// Plain executable JavaScript cannot carry a TypeScript return annotation.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const close = () => server.close(() => process.exit(0))
process.on('SIGTERM', close)
process.on('SIGINT', close)
