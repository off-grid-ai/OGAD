#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- executable JavaScript boundary */

// CU-004 model boundary. The production Web Use host, screenshot capture,
// canonical vision adapter, coordinate mapping, CDP driver, pointer injection,
// takeover coordinator, IPC, task store, and renderer stay real. This process
// returns deterministic strict visual decisions for the local QA page.
import http from 'node:http'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

const MODEL_ID = 'unsloth/Qwen3.5-0.8B-GGUF'
const VISUAL_TOOLS = ['complete_milestone', 'perform_action', 'rethink', 'call_user']
const args = process.argv.slice(2)
const portFlag = Math.max(args.indexOf('--port'), args.indexOf('-p'))
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 8439
const profile = process.env.OFFGRID_USER_DATA
if (profile) writeFileSync(path.join(profile, 'qa-model-port'), String(port))
const pendingDecisions = []
let lastDecision = null
let lastPrompt = ''
let lastAudit = null
let visualRequestCount = 0

const textParts = (payload) =>
  (payload.messages ?? []).flatMap((message) => {
    if (typeof message?.content === 'string') return [message.content]
    if (!Array.isArray(message?.content)) return []
    return message.content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
  })

const imageParts = (payload) =>
  (payload.messages ?? []).flatMap((message) =>
    Array.isArray(message?.content)
      ? message.content.filter(
          (part) =>
            part?.type === 'image_url' &&
            typeof part.image_url?.url === 'string' &&
            part.image_url.url.startsWith('data:image/')
        )
      : []
  )

const auditVisualRequest = (payload, prompt) => {
  const tools = payload.tools ?? []
  const names = tools.map((tool) => tool?.function?.name).sort()
  const errors = []
  if (payload.stream !== true) errors.push('visual request was not streamed')
  if (names.join(',') !== [...VISUAL_TOOLS].sort().join(',')) {
    errors.push('visual tools did not match the canonical contract')
  }
  for (const tool of tools) {
    if (
      tool?.type !== 'function' ||
      tool?.function?.strict !== true ||
      tool?.function?.parameters?.additionalProperties !== false
    ) {
      errors.push(`${tool?.function?.name ?? 'unknown'} was not a strict native tool`)
    }
  }
  if (payload.chat_template_kwargs?.enable_thinking !== true) {
    errors.push('visual decision was not thinking-enabled')
  }
  if (payload.reasoning_format !== 'deepseek') {
    errors.push('visual reasoning was not separated')
  }
  if (imageParts(payload).length !== 1) errors.push('visual request did not contain one screenshot')
  for (const section of [
    'Task brief:',
    'Current milestone:',
    'Recent verified actions:',
    'Screenshot coordinate space:'
  ]) {
    if (!prompt.includes(section)) errors.push(`visual request omitted ${section}`)
  }
  return { valid: errors.length === 0, errors }
}

const verifiedActions = (prompt) =>
  prompt.match(
    /Recent verified actions:\n([\s\S]*?)(?:\n\nPrior validated judge decisions:|\n\nRecent task events:|\n\nScreenshot coordinate space:)/
  )?.[1] ?? ''

const screenshotBounds = (prompt) => {
  const match = prompt.match(/screenshot is (\d+) pixels wide and (\d+) pixels high/i)
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null
}

const toolDecision = (name, args) => ({ name, args })

const verdict = ({ summary, evidence, action = null, milestoneComplete = false }) => {
  if (milestoneComplete) {
    return toolDecision('complete_milestone', {
      summary,
      visible_evidence: evidence
    })
  }
  if (!action) {
    return toolDecision('rethink', {
      direction: 'aligned',
      summary,
      visible_evidence: evidence
    })
  }
  return toolDecision('perform_action', {
    direction: 'aligned',
    summary,
    visible_evidence: evidence,
    action,
    action_reason: 'This one visible action advances the current milestone.'
  })
}

const decisionFor = (prompt) => {
  if (prompt.includes('Create a short execution plan for a web agent.')) {
    return {
      content: JSON.stringify({
        phases: [
          'Enter the requested text',
          'Click the target',
          'Confirm the protected account step'
        ]
      })
    }
  }
  if (prompt.includes('resumed by the user')) return null
  const actions = verifiedActions(prompt)
  if (prompt.includes('Current milestone:\nEnter the requested text')) {
    if (actions.includes('type text')) {
      return verdict({
        summary: 'The requested text is present.',
        evidence: 'The focused text field visibly contains the requested text.',
        milestoneComplete: true
      })
    }
    if (actions.includes('click at (')) {
      return verdict({
        summary: 'Enter the requested text in the focused field.',
        evidence: 'The Type target field is visible and focused.',
        action: { type: 'type', content: 'cursor stays visible' }
      })
    }
    const bounds = screenshotBounds(prompt)
    if (!bounds) {
      return verdict({
        summary: 'The screenshot bounds are unavailable.',
        evidence: 'No exact screenshot coordinate space is available.'
      })
    }
    return verdict({
      summary: 'Focus the visible text field.',
      evidence: 'The Type target field is visible at the specified point.',
      action: { type: 'click', point: { x: 260, y: 320 } }
    })
  }
  if (prompt.includes('Current milestone:\nClick the target')) {
    const clickCount = actions.match(/click at \(/g)?.length ?? 0
    if (clickCount >= 2) {
      return verdict({
        summary: 'The click target was activated.',
        evidence: 'The page visibly reports that the pointer click was recorded.',
        milestoneComplete: true
      })
    }
    const bounds = screenshotBounds(prompt)
    if (!bounds) {
      return verdict({
        summary: 'The screenshot bounds are unavailable.',
        evidence: 'No exact screenshot coordinate space is available.'
      })
    }
    return verdict({
      summary: 'Activate the visible click target.',
      evidence: 'The Click target button is visible at the specified point.',
      action: { type: 'click', point: { x: 260, y: 580 } }
    })
  }
  if (prompt.includes('Current milestone:\nConfirm the protected account step')) {
    return toolDecision('call_user', {
      reason: 'Confirm the protected account step yourself.',
      visible_evidence: 'A password field is visible on the current page.'
    })
  }
  return verdict({
    summary: 'The current milestone is not available.',
    evidence: 'The prompt has no recognized current milestone.'
  })
}

const sendDecision = (response, decision, stream, audit) => {
  if (!audit.valid) {
    response.writeHead(422, { 'Content-Type': 'application/json' })
    response.end(
      JSON.stringify({
        error: { message: `CU-004 canonical request mismatch: ${audit.errors.join('; ')}` }
      })
    )
    return
  }
  if (!decision) {
    response.writeHead(500, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'CU-004 terminal model failure' } }))
    return
  }
  const content = decision.content ?? ''
  const toolCalls = decision.name
    ? [
        {
          index: 0,
          id: `call_${decision.name}`,
          type: 'function',
          function: { name: decision.name, arguments: JSON.stringify(decision.args) }
        }
      ]
    : null
  if (stream) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Reviewed the fresh screenshot and current milestone.' } }] })}\n\n`
    )
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: toolCalls ? { tool_calls: toolCalls } : { content }, finish_reason: toolCalls ? 'tool_calls' : 'stop' }] })}\n\n`
    )
    response.end('data: [DONE]\n\n')
    return
  }
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(
    JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content,
            ...(toolCalls ? { tool_calls: toolCalls } : {})
          },
          finish_reason: toolCalls ? 'tool_calls' : 'stop'
        }
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
    })
  )
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ status: 'ok' }))
    return
  }
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: MODEL_ID }] }))
    return
  }
  if (request.method === 'GET' && request.url === '/props') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ chat_template: '{% if enable_thinking %}<think>{% endif %}' }))
    return
  }
  if (request.method === 'GET' && request.url === '/qa/pending-decision') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ pending: pendingDecisions.length > 0 }))
    return
  }
  if (request.method === 'GET' && request.url === '/qa/state') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ lastDecision, lastPrompt, lastAudit, visualRequestCount }))
    return
  }
  if (request.method === 'POST' && request.url === '/qa/release-decision') {
    pendingDecisions.shift()?.()
    response.writeHead(204)
    response.end()
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
    let payload = null
    try {
      payload = JSON.parse(body)
      if (typeof payload === 'string') payload = JSON.parse(payload)
    } catch {
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'CU-004 request JSON was malformed' } }))
      return
    }
    const prompt = textParts(payload).join('\n\n')
    const isPlan = prompt.includes('Create a short execution plan for a web agent.')
    if (isPlan) {
      const decision = decisionFor(prompt)
      lastPrompt = prompt
      lastDecision = decision
      sendDecision(response, decision, false, { valid: true, errors: [] })
      return
    }
    const audit = auditVisualRequest(payload, prompt)
    visualRequestCount += 1
    lastAudit = audit
    pendingDecisions.push(() => {
      const decision = decisionFor(prompt)
      lastPrompt = prompt
      lastDecision = decision
      sendDecision(response, decision, payload.stream === true, audit)
    })
  })
})

server.listen(port, '127.0.0.1')
const close = () => server.close(() => process.exit(0))
process.on('SIGTERM', close)
process.on('SIGINT', close)
