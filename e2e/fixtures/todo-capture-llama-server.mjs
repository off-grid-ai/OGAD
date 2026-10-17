#!/usr/bin/env node

// The native llama-server boundary for the suggested to-do spec. Every request body is written to
// OFFGRID_TODO_MODEL_LOG. It reads a captured chat with Priya the way a model would:
//   - the capture summary: a conversation with Priya Shah, quoting the window;
//   - the to-do extraction: the ask in the captured text, quoted word for word.
// Anything else gets a short plain answer.

import fs from 'node:fs'
import http from 'node:http'

const args = process.argv.slice(2)
const portFlag = Math.max(args.indexOf('--port'), args.indexOf('-p'))
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 8439
const log = process.env.OFFGRID_TODO_MODEL_LOG

/** The asks a captured chat can hold, and the to-do each one is. */
const ASKS = [
  { quote: 'Please send the Q3 deck by Friday', text: 'Send the Q3 deck', due: 'by Friday' },
  {
    quote: 'Could you book the client dinner for Tuesday',
    text: 'Book the client dinner',
    due: 'for Tuesday'
  }
]

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((part) => part?.type === 'text')
          .map((part) => part.text)
          .join('\n')
      : ''

const delta = (payload) => `data: ${JSON.stringify({ choices: [{ delta: payload }] })}\n\n`

const reply = (response, stream, content) => {
  if (!stream) {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }]
      })
    )
    return
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  response.write(delta({ content }))
  response.end('data: [DONE]\n\n')
}

/** The captured text: the last block between triple quotes (recent activity comes before it). */
const captured = (prompt) => [...prompt.matchAll(/"""\n([\s\S]*?)\n"""/g)].at(-1)?.[1] ?? prompt

const answer = (prompt) => {
  if (prompt.includes('extract genuine ACTION ITEMS')) {
    const text = captured(prompt)
    const items = ASKS.filter((ask) => text.includes(ask.quote)).map((ask) => ({
      text: ask.text,
      quote: ask.quote,
      owner: 'me',
      assignee: '',
      due: ask.due,
      confidence: 0.9
    }))
    return JSON.stringify({ items })
  }
  if (prompt.includes('You log what the user is DOING')) {
    const ask = ASKS.find((candidate) => captured(prompt).includes(candidate.quote))
    return JSON.stringify(
      ask
        ? {
            skip: false,
            category: 'communication',
            summary: `Slack DM with Priya Shah: "${ask.quote}"`,
            entities: [{ name: 'Priya Shah', type: 'Person' }]
          }
        : { skip: true, category: 'other', summary: '', entities: [] }
    )
  }
  return 'Plain answer.'
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ status: 'ok' }))
    return
  }
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'todo-capture-model' }] }))
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
    const prompt = (payload.messages ?? []).map((message) => textOf(message.content)).join('\n')
    reply(response, payload.stream === true, answer(prompt))
  })
})

server.listen(port, '127.0.0.1')
const shutdown = () => server.close(() => process.exit(0))
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
