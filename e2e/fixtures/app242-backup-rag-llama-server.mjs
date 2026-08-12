#!/usr/bin/env node

// APP-242's only model fake: the native llama-server HTTP boundary. The app,
// project/RAG services, embeddings, backup archive, restore, SQLite, IPC and UI
// all remain production code. This boundary deliberately refuses to reveal the
// answer unless the real search_knowledge_base result reaches the model prompt.

import http from 'node:http'

const args = process.argv.slice(2)
const portFlag = Math.max(args.indexOf('--port'), args.indexOf('-p'))
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 8439

const delta = (payload) => `data: ${JSON.stringify({ choices: [{ delta: payload }] })}\n\n`

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ status: 'ok' }))
    return
  }
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'app242-local-model' }] }))
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
    // The token can only enter a model request through the real KB tool result:
    // it is absent from the user's question, model fixture, and tool schema.
    const hasRetrievedFact = body.includes('ORBIT-731')

    response.writeHead(200, {
      'Content-Type': payload.stream ? 'text/event-stream' : 'application/json'
    })

    if (!payload.stream) {
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: hasRetrievedFact
                  ? 'ORBIT-731'
                  : 'I cannot answer without the project knowledge source.'
              }
            }
          ]
        })
      )
      return
    }

    if (!hasRetrievedFact) {
      response.write(
        delta({
          tool_calls: [
            {
              index: 0,
              id: 'app242-search',
              type: 'function',
              function: {
                name: 'search_knowledge_base',
                arguments: JSON.stringify({ query: 'Aurora launch passphrase' })
              }
            }
          ]
        })
      )
    } else {
      const answer = hasRetrievedFact
        ? 'ORBIT-731'
        : 'I cannot answer without the project knowledge source.'
      response.write(delta({ content: answer }))
    }
    response.write('data: [DONE]\n\n')
    response.end()
  })
})

server.listen(port, '127.0.0.1')

const close = () => server.close(() => process.exit(0))
process.on('SIGTERM', close)
process.on('SIGINT', close)
