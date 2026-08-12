#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type -- executable JavaScript fixture */

// APP-068's only model fake: the native llama-server HTTP boundary. The rendered
// app, project store, real document extraction, MiniLM embeddings, vector search,
// RAG prompt assembly, SQLite, IPC and preload remain production code. This boundary acts
// as an isolation oracle: it reveals a requested identifier only when that exact
// identifier reached the model through the real project knowledge search result.

import http from 'node:http'

const args = process.argv.slice(2)
const portFlag = Math.max(args.indexOf('--port'), args.indexOf('-p'))
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 8439

const ALPHA_FACT = 'COMET-ALPHA-417'
const BETA_FACT = 'TIDE-BETA-928'
const NOT_FOUND = 'That identifier is not present in this project knowledge.'

const delta = (payload) => `data: ${JSON.stringify({ choices: [{ delta: payload }] })}\n\n`

function requestedTopic(body) {
  // Project prompts can contain sibling-chat history with earlier questions.
  // The final `User:` cue is the current turn; use only that cue to choose the
  // requested fact while inspecting the whole body for leaked retrieval data.
  const currentTurn = body.slice(body.lastIndexOf('User:')).toLowerCase()
  if (currentTurn.includes('marine identifier')) return 'marine'
  if (currentTurn.includes('celestial identifier')) return 'celestial'
  return 'unknown'
}

function answerFor(body) {
  const topic = requestedTopic(body)
  if (topic === 'celestial' && body.includes(ALPHA_FACT)) return ALPHA_FACT
  if (topic === 'marine' && body.includes(BETA_FACT)) return BETA_FACT
  return NOT_FOUND
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ status: 'ok' }))
    return
  }

  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'app068-project-isolation' }] }))
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
      response.end(JSON.stringify({ choices: [{ message: { content: answerFor(body) } }] }))
      return
    }

    response.write(delta({ content: answerFor(body) }))
    response.write('data: [DONE]\n\n')
    response.end()
  })
})

server.listen(port, '127.0.0.1')

const close = () => server.close(() => process.exit(0))
process.on('SIGTERM', close)
process.on('SIGINT', close)
