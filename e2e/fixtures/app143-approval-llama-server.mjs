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
      let text = 'Ready to review an action.'
      if (result) {
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
