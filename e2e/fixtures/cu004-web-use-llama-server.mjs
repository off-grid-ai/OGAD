#!/usr/bin/env node

// CU-004 model boundary. The production Web Use host, screenshot capture,
// canonical vision adapter, coordinate mapping, CDP driver, pointer injection,
// takeover coordinator, IPC, task store, and renderer stay real. This process
// returns deterministic strict visual decisions for the local QA page.
import http from 'node:http'
import { appendFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const MODEL_ID = 'mradermacher/UI-TARS-1.5-7B-GGUF'
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
  if (imageParts(payload).length < 1) errors.push('visual request did not contain a screenshot')
  if (!/Screenshot: \d+ pixels wide and \d+ pixels high/i.test(prompt)) {
    errors.push('visual request omitted exact screenshot bounds')
  }
  for (const section of ['Task brief:', 'Current milestone:', 'Screenshot:']) {
    if (!prompt.includes(section)) errors.push(`visual request omitted ${section}`)
  }
  return { valid: errors.length === 0, errors }
}

const toolDecision = (name, args) => ({ name, args })

const verdict = ({ summary, evidence, action = null, milestoneComplete = false }) => {
  if (milestoneComplete) {
    return toolDecision('complete_milestone', {
      summary,
      visible_evidence: evidence,
      continuation: { done: [summary], next: '', remember: '' }
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
    action_reason: 'This one visible action advances the current milestone.',
    intent: summary,
    expected_state: 'The requested action is visible on the page.',
    continuation: { done: [], next: 'Check the action result', remember: '' }
  })
}

const decisionFor = (prompt) => {
  if (prompt.includes('Create a short execution plan for a web agent.')) {
    return {
      content: JSON.stringify({
        phases: [
          'Focus the text field',
          'Enter the requested text',
          'Click the target',
          'Confirm the protected account step'
        ]
      })
    }
  }
  // 47159c74ab records this note for ordinary Pause/Resume as well as handoff.
  // Resume must not turn a healthy model into a permanent HTTP 500 boundary.

  // 9b3b476a0d requires the fresh observation to resolve each action before another action.
  // Keep each phase atomic, as the current planner requests, and confirm it on the next frame.
  const milestone = prompt.split('Current milestone:\n').at(-1)?.split('\n\n')[0]
  const verifying = prompt.includes('Previous expected state:')
  if (milestone === 'Focus the text field') {
    return verdict({
      summary: verifying ? 'The text field is focused.' : 'Focus the visible text field.',
      evidence: 'The Type target field is visible.',
      milestoneComplete: verifying,
      action: verifying ? null : { type: 'click', point: { x: 260, y: 320 } }
    })
  }
  if (milestone === 'Enter the requested text') {
    return verdict({
      summary: verifying ? 'The requested text is present.' : 'Enter the requested text.',
      evidence: 'The Type target field is visible and focused.',
      milestoneComplete: verifying,
      action: verifying ? null : { type: 'type', content: 'cursor stays visible' }
    })
  }
  if (milestone === 'Click the target') {
    return verdict({
      summary: verifying ? 'The click target was activated.' : 'Activate the click target.',
      evidence: verifying
        ? 'The page reports that the pointer click was recorded.'
        : 'The Click target button is visible.',
      milestoneComplete: verifying,
      action: verifying ? null : { type: 'click', point: { x: 260, y: 580 } }
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
    if (profile)
      appendFileSync(path.join(profile, 'model-requests.jsonl'), `${JSON.stringify(payload)}\n`)
    const prompt = textParts(payload).join('\n\n')
    // a52569ed47: Web Use first tries a semantic Playwright decision. This journey exercises
    // visual controls, so the external model asks the real host to use its visual fallback.
    if (payload.response_format?.json_schema?.name === 'web_use_step') {
      const fields = Object.fromEntries(
        payload.response_format.json_schema.schema.required.map((key) => [key, null])
      )
      sendDecision(
        response,
        {
          content: JSON.stringify({
            ...fields,
            action: 'fallback',
            reason: 'Use the screenshot to target this visual test page.',
            summary: 'Continue with visual controls.'
          })
        },
        false,
        { valid: true, errors: [] }
      )
      return
    }
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
