#!/usr/bin/env node

// Behaviour-faithful native-model boundary for Electron E2E. The app launches
// this executable through the real LLMService and talks to it over llama.cpp's
// OpenAI-compatible HTTP/SSE contract. Everything above the native process stays
// real: IPC, toolChat, tool dispatch, renderer orchestration, and persistence.

import http from 'node:http'

const args = process.argv.slice(2)
const portFlag = Math.max(args.indexOf('--port'), args.indexOf('-p'))
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 8439
let imageToolRequested = false
// Plain executable JavaScript cannot carry a TypeScript return annotation.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const delta = (payload) => `data: ${JSON.stringify({ choices: [{ delta: payload }] })}\n\n`

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ status: 'ok' }))
    return
  }
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'e2e-tool-model' }] }))
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
      response.end(
        JSON.stringify({
          choices: [{ message: { content: 'Here is your weekly summary.' } }],
          usage: { total_tokens: 0 }
        })
      )
      return
    }

    // Model-server readiness and capability probes can issue completions before the user turn.
    // Route from the OpenAI conversation contract instead of request order: the first agent round
    // has no tool result, while the follow-up round does. This keeps the native boundary fake
    // faithful when startup probes change without teaching it any Off Grid implementation detail.
    const offersImageTool =
      Array.isArray(payload.tools) &&
      payload.tools.some((tool) => tool?.function?.name === 'generate_image')

    if (offersImageTool && !imageToolRequested) {
      imageToolRequested = true
      response.write(
        delta({
          tool_calls: [
            {
              index: 0,
              id: 'call_generate_image',
              type: 'function',
              function: {
                name: 'generate_image',
                arguments: JSON.stringify({ prompt: 'a weekly activity chart' })
              }
            }
          ]
        })
      )
    } else {
      response.write(delta({ content: 'Here is your ' }))
      response.write(delta({ content: 'weekly summary.' }))
    }
    response.write('data: [DONE]\n\n')
    response.end()
  })
})

server.listen(port, '127.0.0.1')

// Plain executable JavaScript cannot carry a TypeScript return annotation.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const close = () => server.close(() => process.exit(0))
process.on('SIGTERM', close)
process.on('SIGINT', close)
