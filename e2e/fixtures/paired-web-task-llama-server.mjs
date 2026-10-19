#!/usr/bin/env node

// The native llama-server boundary for a web task in the paired browser. Every request body is
// written to OFFGRID_WEB_TASK_LOG.
//   - A chat turn that asks for the headline calls web_use; once the tool has answered, it reports.
//   - The task's plan request gets two phases.
//   - A page step returns "done" with the headline the snapshot shows. With OFFGRID_WEB_TASK_HOLD
//     set, or for a task whose goal says "slowly", a page step is held open until the client goes
//     away, so a spec can stop the task.

import fs from 'node:fs'
import http from 'node:http'

const args = process.argv.slice(2)
const portFlag = Math.max(args.indexOf('--port'), args.indexOf('-p'))
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 8439
const log = process.env.OFFGRID_WEB_TASK_LOG
const hold = process.env.OFFGRID_WEB_TASK_HOLD === '1'

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

const reply = (response, stream, message) => {
  if (!stream) {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', ...message }, finish_reason: 'stop' }]
      })
    )
    return
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  if (message.tool_calls) {
    response.write(
      delta({ tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) })
    )
  } else {
    response.write(delta({ content: message.content }))
  }
  response.end('data: [DONE]\n\n')
}

const step = (prompt) => {
  const phase = prompt.match(/Plan:\n([^:\n]+):/)?.[1] ?? null
  const headline = prompt.match(/heading "([^"]+)"/)?.[1]
  const empty = {
    element: null,
    ref: null,
    text: null,
    key: null,
    values: null,
    start_element: null,
    start_ref: null,
    end_element: null,
    end_ref: null,
    url: null,
    evidence_ref: null
  }
  return JSON.stringify({
    ...empty,
    action: 'done',
    phase_id: phase,
    evidence_text: headline ?? null,
    reason: 'The page shows the headline.',
    summary: `The headline is ${headline}.`
  })
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ status: 'ok' }))
    return
  }
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'paired-web-task-model' }] }))
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
    const messages = payload.messages ?? []
    const prompt = messages.map((message) => textOf(message.content)).join('\n')
    const stream = payload.stream === true
    if (prompt.includes('You control one visible browser page with Playwright')) {
      const goal = prompt.match(/Goal: ([^\n]*(?:\n[^\n]+)*)/)?.[1] ?? ''
      if (hold || /slowly/i.test(goal)) return // held until Stop closes the request
      reply(response, stream, { content: step(prompt) })
      return
    }
    if (prompt.includes('Create a short execution plan for a web agent.')) {
      reply(response, stream, {
        content: JSON.stringify({ phases: ['Read the page', 'Report the headline'] })
      })
      return
    }
    const webUse = (payload.tools ?? []).some((tool) => tool.function?.name === 'web_use')
    const toolResult = messages.find((message) => message.role === 'tool')
    if (webUse && !toolResult && prompt.includes('headline')) {
      const slowly = /slowly/i.test(textOf(messages.filter((m) => m.role === 'user').at(-1)?.content))
      reply(response, stream, {
        content: '',
        tool_calls: [
          {
            id: 'call_web_use',
            type: 'function',
            function: {
              name: 'web_use',
              arguments: JSON.stringify({
                goal: slowly
                  ? 'Read the headline on the open page slowly.'
                  : 'Read the headline on the open page.'
              })
            }
          }
        ]
      })
      return
    }
    reply(response, stream, {
      content: toolResult ? `Web task reported: ${textOf(toolResult.content).slice(0, 120)}` : 'OK'
    })
  })
})

server.listen(port, '127.0.0.1')
const shutdown = () => server.close(() => process.exit(0))
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
