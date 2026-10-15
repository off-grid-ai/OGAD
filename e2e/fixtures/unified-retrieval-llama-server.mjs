#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type -- executable JavaScript fixture */

// The unified retrieval journey's only model fake: the native llama-server HTTP boundary. The
// rendered app, chat storage, the search index (FTS + trigram), the record search service, the
// search_memory tool, citation numbering, the date line in the system prompt, IPC and the chat UI
// remain production code. Like a small local model, this boundary answers only from what reached
// it: a fact it repeats must have come back through the real search_memory result, and the date it
// states must have come from the real system prompt.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const portFlag = Math.max(args.indexOf('--port'), args.indexOf('-p'))
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 8439

// What reached the model, one line per request, beside this executable: the spec prints it when a
// journey fails, so a wrong answer shows what retrieval actually returned.
const LOG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'requests.jsonl')

const delta = (payload) => `data: ${JSON.stringify({ choices: [{ delta: payload }] })}\n\n`

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => part?.text ?? '').join('')
  return ''
}

function lastUser(messages) {
  const user = [...messages].reverse().find((message) => message.role === 'user')
  return textOf(user?.content)
}

function replyFor(payload) {
  const messages = payload.messages ?? []
  const question = lastUser(messages)
  const asked = question.toLowerCase()

  // "What is today's date?": read it from the system prompt's date line, never from a clock here.
  // (Only the user's own question: the app's follow-up suggestions quote it after "The user asked:".)
  if (asked.startsWith("what is today's date")) {
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => textOf(message.content))
      .join('\n')
    const date = /Current date: ([^(]+?) \(/.exec(system)?.[1]
    return date ? `Today is ${date}.` : 'I do not know the date.'
  }

  // A memory question: search first, then answer only from the tool result.
  if (asked.startsWith('search my memory')) {
    const offered = (payload.tools ?? []).some((tool) => tool?.function?.name === 'search_memory')
    const userIndex = messages.map((message) => message.role).lastIndexOf('user')
    const results = messages
      .slice(userIndex + 1)
      .filter((message) => message.role === 'tool')
      .map((message) => textOf(message.content))
      .join('\n')
    if (!offered) return 'search_memory was not offered.'
    if (!results) {
      return `<tool_call>${JSON.stringify({
        name: 'search_memory',
        arguments: { query: 'Kunal RBI filing promise' }
      })}</tool_call>`
    }
    const source = /<source id="S(\d+)"[^>]*\bat="([^"]+)"[^>]*>([^<]*RBI filing[^<]*)<\/source>/.exec(
      results
    )
    if (!source) return 'I found nothing about that in your memory.'
    return `You promised Kunal the RBI filing by Friday [S${source[1]}]. Noted ${source[2].slice(0, 10)}.`
  }

  // Anything else: acknowledge this exact message, so the journey can wait for its own reply.
  return `Noted (${[...question].length}).`
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ status: 'ok' }))
    return
  }
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'unified-retrieval-model' }] }))
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
    let payload = {}
    try {
      payload = JSON.parse(body)
    } catch {
      /* answer the default */
    }
    const text = replyFor(payload)
    const messages = payload.messages ?? []
    fs.appendFileSync(
      LOG,
      `${JSON.stringify({
        question: lastUser(messages),
        tools: (payload.tools ?? []).map((tool) => tool?.function?.name),
        toolResults: messages.filter((m) => m.role === 'tool').map((m) => textOf(m.content)),
        reply: text
      })}\n`
    )
    if (payload.stream === false) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }]
        })
      )
      return
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    for (const piece of text.match(/.{1,24}/gsu) ?? []) response.write(delta({ content: piece }))
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`
    )
    response.write('data: [DONE]\n\n')
    response.end()
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`unified-retrieval fake llama-server listening on ${port}`)
})
