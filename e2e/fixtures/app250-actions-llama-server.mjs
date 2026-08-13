#!/usr/bin/env node

// APP-250's model boundary: a scripted llama-server. The production app still
// owns model discovery, the tool loop, tool-call parsing, the @offgrid/use
// engine, the semantic rail, read-back verification, IPC, and rendering.
// Turn 1 (an agentic turn carrying the reminders_create schema): emit the
// tool call AS TEXT, exactly how small local models do. Turn 2 (the request
// carries the tool's result): confirm in plain text.

import http from 'node:http'

const args = process.argv.slice(2)
const portFlag = Math.max(args.indexOf('--port'), args.indexOf('-p'))
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 8439

const delta = (content, finishReason = null) =>
  `data: ${JSON.stringify({ choices: [{ delta: content ? { content } : {}, finish_reason: finishReason }] })}\n\n`

const TOOL_CALL =
  '<tool_call>{"name":"reminders_create","arguments":{"title":"Send the deck","due":"2026-08-14T18:00:00"}}</tool_call>'
const CONFIRMATION = 'Done - the reminder is set for 6pm today.'

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ status: 'ok' }))
    return
  }
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'app250-local-model' }] }))
    return
  }
  if (request.method !== 'POST' || !String(request.url).includes('/chat/completions')) {
    response.writeHead(404)
    response.end()
    return
  }
  let body = ''
  request.on('data', (chunk) => {
    body += chunk
  })
  request.on('end', () => {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    const isAgenticFirstTurn = body.includes('reminders_create') && !body.includes('Created the reminder.')
    const text = isAgenticFirstTurn ? TOOL_CALL : CONFIRMATION
    for (const piece of text.match(/.{1,24}/gs) ?? []) {
      response.write(delta(piece))
    }
    response.write(delta(null, 'stop'))
    response.write('data: [DONE]\n\n')
    response.end()
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`app250 fake llama-server listening on ${port}`)
})
