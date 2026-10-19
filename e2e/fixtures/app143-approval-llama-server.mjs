#!/usr/bin/env node

// Native llama-server boundary. Tool names come from the real request schema;
// arguments come from the brief submitted through the approval form.
import fs from 'node:fs'
import http from 'node:http'

const args = process.argv.slice(2)
const portFlag = Math.max(args.indexOf('--port'), args.indexOf('-p'))
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 8439
const delta = (content, finishReason = null) =>
  `data: ${JSON.stringify({ choices: [{ delta: content ? { content } : {}, finish_reason: finishReason }] })}\n\n`

http
  .createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ status: 'ok' }))
      return
    }
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'app143-local-model' }] }))
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
      const payload = JSON.parse(body)
      fs.appendFileSync(process.env.OFFGRID_APP143_MODEL_LOG, `${body}\n`)
      const tool = payload.tools?.find((entry) =>
        /^mcp__\d+__create_external_task$/.test(entry.function?.name)
      )
      const messages = (payload.messages ?? []).map((message) => ({
        ...message,
        content: Array.isArray(message.content)
          ? message.content
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('\n')
          : message.content
      }))
      const result = messages.find((message) => message.role === 'tool')
      const brief = messages.find(
        (message) =>
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content.includes('Complete this approved action now.')
      )?.content
      const prompt = messages
        .filter((message) => message.role === 'user' && typeof message.content === 'string')
        .map((message) => message.content)
        .join('\n')
      let text = 'Ready to review an action.'
      // A scheduled routine asks for the same write on its own; nobody is watching, so the app
      // must hold it for approval. Once the tool answers (held), the routine reports it.
      const routine = prompt.includes('File the guarded release task in Desktop P0.')
      if (routine && tool && !result && !brief) {
        text = `<tool_call>${JSON.stringify({ name: tool.function.name, arguments: { title: 'Ship guarded approval journey', project: 'Desktop P0' } })}</tool_call>`
      } else if (routine && result && !brief) {
        text = 'The release task is waiting for your approval.'
      } else if (prompt.includes('You are my proactive personal secretary.')) {
        // The secretary proposes the write that completes the to-do, citing it as evidence.
        const todo = prompt.match(/\[(T\d+)\] (Ship guarded approval journey[^\n]*)/)
        if (!todo) throw new Error('The secretary prompt is missing the APP-143 to-do')
        text = JSON.stringify({
          actions: [
            {
              connector: 'APP-143 guarded connector',
              tool: 'create_external_task',
              args: { title: 'Ship guarded approval journey', project: 'Desktop P0' },
              title: 'Create APP-143 release task',
              why: 'The open to-do asks to ship the guarded approval journey in Desktop P0.',
              entity: 'Off Grid AI Desktop',
              source: todo[1],
              quote: 'Ship guarded approval journey'
            }
          ]
        })
      } else if (prompt.includes('You are the quality gate for my proactive assistant.')) {
        text = JSON.stringify({ keep: [1] })
      } else if (result) {
        text = `Created external task. ${result.content}`
      } else if (tool && brief) {
        const title = brief.match(/^title: (.+)$/m)?.[1]
        const project = brief.match(/^project: (.+)$/m)?.[1]
        if (!title || !project) throw new Error('Approved task inputs missing')
        text = `<tool_call>${JSON.stringify({ name: tool.function.name, arguments: { title, project } })}</tool_call>`
      }
      if (!payload.stream) {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }]
          })
        )
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      for (const piece of text.match(/.{1,24}/gs) ?? []) response.write(delta(piece))
      response.write(delta(null, 'stop'))
      response.end('data: [DONE]\n\n')
    })
  })
  .listen(port, '127.0.0.1')
