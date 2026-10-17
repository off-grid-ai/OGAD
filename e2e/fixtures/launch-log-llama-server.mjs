#!/usr/bin/env node

// A native llama-server boundary that records how it was launched. Each launch's arguments, and
// each chat request, are written to OFFGRID_LLAMA_LAUNCH_LOG. It refuses the quantized KV cache
// flag the way a llama.cpp build without that option does: it prints the error and exits before
// it listens. Every other launch serves llama.cpp's OpenAI-compatible HTTP/SSE contract.

import fs from 'node:fs'
import http from 'node:http'

const args = process.argv.slice(2)
const portFlag = Math.max(args.indexOf('--port'), args.indexOf('-p'))
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 8439
const log = process.env.OFFGRID_LLAMA_LAUNCH_LOG
const REFUSED_FLAG = '--cache-type-k'

const record = (entry) => {
  if (log) fs.appendFileSync(log, `${JSON.stringify(entry)}\n`)
}

record({ event: 'launch', args })

if (args.includes(REFUSED_FLAG)) {
  process.stderr.write(`error: invalid argument: ${REFUSED_FLAG}\n`)
  process.exit(1)
}

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
    response.end(JSON.stringify({ data: [{ id: 'launch-log-model' }] }))
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
    record({ event: 'chat', body })
    const text = 'The local engine answered.'
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
