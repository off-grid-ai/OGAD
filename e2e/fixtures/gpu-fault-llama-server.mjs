#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type -- executable JavaScript fixture */

// The GPU fault journey's only fake: the native llama-server boundary. Everything that decides what
// happens after a fault (the HTTP client's classifier, the chat fallback policy, the same-model
// restart, the backend ladder, the CPU-only launch flags, the runtime status and Settings) is
// production code. Like a real engine, this one reports where it put the model in its load log,
// and like a GPU that has lost its context it answers "500 Compute error" for as many questions as
// faults.json beside it still lists. A fault is spent when it is answered, across restarts.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const portFlag = Math.max(args.indexOf('--port'), args.indexOf('-p'))
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 8439
const deviceFlag = args.indexOf('--device')
const cpuOnly = deviceFlag >= 0 && args[deviceFlag + 1] === 'none'
const here = path.dirname(fileURLToPath(import.meta.url))
const FAULTS = path.join(here, 'faults.json')
const LOG = path.join(here, 'launches.jsonl')

fs.appendFileSync(LOG, `${JSON.stringify({ args })}\n`)

// The load log the app reads to name the backend and the layers on the GPU.
if (cpuOnly) {
  process.stderr.write('load_tensors: CPU model buffer size = 120.00 MiB\n')
} else {
  process.stderr.write('load_tensors: offloaded 28/28 layers to GPU\n')
  process.stderr.write('load_tensors: Metal model buffer size = 120.00 MiB\n')
}

function takeFault() {
  try {
    const plan = JSON.parse(fs.readFileSync(FAULTS, 'utf8'))
    if (!(plan.remaining > 0)) return false
    fs.writeFileSync(FAULTS, JSON.stringify({ remaining: plan.remaining - 1 }))
    return true
  } catch {
    return false
  }
}

function lastUser(messages) {
  const user = [...(messages ?? [])].reverse().find((message) => message.role === 'user')
  const content = user?.content
  return typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => part?.text ?? '').join('')
      : ''
}

const delta = (payload) => `data: ${JSON.stringify({ choices: [{ delta: payload }] })}\n\n`

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ status: 'ok' }))
    return
  }
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'gpu-fault-model' }] }))
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
    const question = lastUser(payload.messages)
    // Only the journey's own questions fault; follow-up suggestions and titles answer normally.
    const faulted = question.startsWith('GPU check') && takeFault()
    fs.appendFileSync(
      LOG,
      `${JSON.stringify({ question: question.slice(0, 80), stream: payload.stream !== false, faulted, cpuOnly })}\n`
    )
    if (faulted) {
      response.writeHead(500, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({ error: { code: 500, message: 'Compute error', type: 'server_error' } })
      )
      return
    }
    const text = question.startsWith('GPU check')
      ? `Answered on the ${cpuOnly ? 'CPU' : 'GPU'}.`
      : 'Okay.'
    if (payload.stream === false) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [
            { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }
          ]
        })
      )
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    response.write(delta({ content: text }))
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`
    )
    response.write('data: [DONE]\n\n')
    response.end()
  })
})

server.listen(port, '127.0.0.1')
