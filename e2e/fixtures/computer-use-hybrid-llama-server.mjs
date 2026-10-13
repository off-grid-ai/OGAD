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

const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  } catch {
    return {}
  }
}

const increment = (key) => {
  const state = readState()
  state[key] = (state[key] ?? 0) + 1
  fs.writeFileSync(stateFile, JSON.stringify(state))
  return state[key]
}

const toolCall = (name, value) => ({
  index: 0,
  id: `call_${name}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(value) }
})

const responseFor = (body) => {
  const payload = JSON.parse(body)
  const names = (payload.tools ?? []).map((tool) => tool.function.name)
  if (names.includes('confirm_action_result')) {
    increment('verificationCalls')
    return {
      toolCalls: [
        toolCall('confirm_action_result', {
          summary: 'The test window was clicked.',
          visible_evidence: 'The test window remains visible after the click.'
        })
      ]
    }
  }
  // d94beace5f: the reasoner chooses the verb and target; the specialist supplies coordinates.
  if (names.includes('ground_pointer_target')) {
    const count = increment('reasonerCalls')
    return count === 1
      ? {
          toolCalls: [
            toolCall('ground_pointer_target', {
              action: 'click',
              target: 'the center of the visible test window',
              expected_effect: 'The test window receives a click.',
              continuation: { done: [], next: 'Verify the click', remember: '' },
              summary: 'Click the visible test window.',
              visible_evidence: 'The Off Grid AI test window is visible.'
            })
          ]
        }
      : {
          toolCalls: [
            toolCall('complete_milestone', {
              summary: 'The test window was clicked.',
              visible_evidence: 'The current screen remains visible after the click.',
              continuation: { done: ['Clicked the test window'], next: '', remember: '' }
            })
          ]
        }
  }
  // 5a72f8680 removed per-adapter token limits. Identify the native UI-TARS protocol.
  if (body.includes('ONE action in the UI-TARS action space')) {
    return increment('specialistCalls') === 1
      ? { content: "click(point='<point>320 200</point>')" }
      : { content: 'subtask_complete()' }
  }
  if (names.includes('perform_action')) {
    return increment('sameAsChatCalls') === 1
      ? {
          toolCalls: [
            toolCall('perform_action', {
              direction: 'aligned',
              summary: 'Click the visible test window.',
              visible_evidence: 'The Off Grid AI test window is visible.',
              action: { type: 'click', point: { x: 500, y: 500 } },
              action_reason: 'The requested target is the center of the visible window.',
              intent: 'Click the test window',
              expected_state: 'The test window has received the click.',
              continuation: { done: [], next: 'Verify the click', remember: '' }
            })
          ]
        }
      : {
          toolCalls: [
            toolCall('complete_milestone', {
              summary: 'The test window was clicked.',
              visible_evidence: 'The current screen remains visible after the click.',
              continuation: { done: ['Clicked the test window'], next: '', remember: '' }
            })
          ]
        }
  }
  if (body.includes('Create a short execution plan for a computer-use agent.')) {
    return {
      content: JSON.stringify({
        version: 1,
        phases: [{ id: 'click-window', title: 'Click the test window' }]
      })
    }
  }
  if (
    names.includes('computer_use') &&
    !payload.messages.some((message) => message.role === 'tool')
  ) {
    return {
      content:
        '<tool_call>{"name":"computer_use","arguments":{"goal":"Click the center of the visible Off Grid AI test window."}}</tool_call>'
    }
  }
  return { content: 'Done - the Computer Use task completed.' }
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
