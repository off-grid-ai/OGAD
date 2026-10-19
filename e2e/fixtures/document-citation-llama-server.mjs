#!/usr/bin/env node

// The native llama-server boundary for the attached-document spec. Every request body is written
// to OFFGRID_DOCUMENT_MODEL_LOG. It answers the way a grounded model does: when a source in the
// prompt holds the fact asked about, the answer quotes it and cites that source's [S#] tag; when
// none does, it says so.

import fs from 'node:fs'
import http from 'node:http'

const args = process.argv.slice(2)
const portFlag = Math.max(args.indexOf('--port'), args.indexOf('-p'))
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 8439
const log = process.env.OFFGRID_DOCUMENT_MODEL_LOG
const FACT = 'ORCHID-7741'

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
    response.end(JSON.stringify({ data: [{ id: 'document-model' }] }))
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
    const prompt = JSON.stringify(payload.messages ?? [])
      .replaceAll('\\n', '\n')
      .replaceAll('\\"', '"')
    let text = 'The documents do not say.'
    for (const match of prompt.matchAll(/<source id="(S\d+)"[^>]*>\n([\s\S]*?)\n<\/source>/g)) {
      if (match[2].includes(FACT)) {
        text = `The harbour safe code is ${FACT} [${match[1]}].`
        break
      }
    }
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
