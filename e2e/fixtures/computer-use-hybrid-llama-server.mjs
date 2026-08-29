#!/usr/bin/env node

// The only model fake for the hybrid Computer Use E2E. The app still owns
// settings, IPC, model swaps, the action engine, task graph, capture evidence,
// actuation adapter, task history, supervisor, and rendered task state.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const args = process.argv.slice(2)
const portFlag = Math.max(args.indexOf('--port'), args.indexOf('-p'))
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 8439
const stateFile = path.join(process.env.OFFGRID_USER_DATA, 'hybrid-model-state.json')
const requestLog = path.join(process.env.OFFGRID_USER_DATA, 'hybrid-model-requests.jsonl')

const readCount = () => {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8')).reasonerCalls ?? 0
  } catch {
    return 0
  }
}

const writeCount = (reasonerCalls) => fs.writeFileSync(stateFile, JSON.stringify({ reasonerCalls }))

const toolCall = (name, value) => ({
  index: 0,
  id: `call_${name}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(value) }
})

const responseFor = (body) => {
  if (body.includes('delegate_grounded_action')) {
    const count = readCount()
    writeCount(count + 1)
    return count === 0
      ? {
          toolCalls: [
            toolCall('delegate_grounded_action', {
              instruction: 'Move the pointer to the center of the visible test window.',
              summary: 'Point at the visible test window.',
              visible_evidence: 'The Off Grid AI test window is visible.'
            })
          ]
        }
      : {
          toolCalls: [
            toolCall('complete_milestone', {
              summary: 'The pointer moved to the test window.',
              visible_evidence: 'The current screen remains visible after the pointer move.'
            })
          ]
        }
  }
  // The production UI-TARS adapter owns the specialist request budget. Match that native
  // boundary instead of a presentation string that is not required to include the model name.
  if (body.includes('"max_tokens":200')) {
    return { content: "mouse_move(point='<point>500 500</point>')" }
  }
  if (body.includes('execution plan') || body.includes('Execution plan')) {
    return {
      content: JSON.stringify({
        version: 1,
        phases: [{ id: 'move-pointer', title: 'Move the pointer to the test window' }]
      })
    }
  }
  if (body.includes('computer_task') && !body.includes('The pointer moved to the test window.')) {
    return {
      content:
        '<tool_call>{"name":"computer_task","arguments":{"goal":"Move the pointer to the center of the visible Off Grid AI test window."}}</tool_call>'
    }
  }
  return { content: 'Done - the hybrid Computer Use task completed.' }
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ status: 'ok' }))
    return
  }
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'e2e-hybrid-model' }] }))
    return
  }
  if (request.method !== 'POST' || !String(request.url).includes('/chat/completions')) {
    response.writeHead(404)
    response.end()
    return
  }
  let raw = ''
  request.on('data', (chunk) => {
    raw += chunk
  })
  request.on('end', () => {
    const body = JSON.parse(raw)
    fs.appendFileSync(requestLog, `${JSON.stringify(body)}\n`)
    const turn = responseFor(raw)
    if (body.stream !== true) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: turn.content ?? '',
                ...(turn.toolCalls ? { tool_calls: turn.toolCalls } : {})
              }
            }
          ],
          usage: { total_tokens: 0 }
        })
      )
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (turn.toolCalls) {
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: turn.toolCalls } }] })}\n\n`
      )
    } else if (turn.content) {
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: turn.content } }] })}\n\n`
      )
    }
    response.write('data: [DONE]\n\n')
    response.end()
  })
})

server.listen(port, '127.0.0.1')
