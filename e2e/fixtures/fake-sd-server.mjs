#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
// A resident stable-diffusion.cpp sd-server at the native boundary: the sdcpp job API the app
// speaks (capabilities, img_gen, job polling with a step preview, cancel). Every job runs its
// sample_steps over about a second each, publishing a preview frame per step, then completes with
// a different final image. Events go to OFFGRID_FAKE_SD_SERVER_LOG.
import fs from 'node:fs'
import http from 'node:http'
import zlib from 'node:zlib'

const portFlag = process.argv.indexOf('--listen-port')
const port = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : 7860
const logPath = process.env.OFFGRID_FAKE_SD_SERVER_LOG
const log = (event, detail = {}) => {
  if (logPath)
    fs.appendFileSync(
      logPath,
      `${JSON.stringify({ event, pid: process.pid, at: Date.now(), ...detail })}\n`
    )
}

// Two real, distinct PNGs (solid 8×8 colours): the preview frame and the finished image.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc = (buffer) => {
  let c = 0xffffffff
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const sum = Buffer.alloc(4)
  sum.writeUInt32BE(crc(body))
  return Buffer.concat([length, body, sum])
}
const png = ([r, g, b]) => {
  const size = 8
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const rows = Buffer.concat(
    Array.from({ length: size }, () =>
      Buffer.from([0, ...Array.from({ length: size }, () => [r, g, b]).flat()])
    )
  )
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0))
  ]).toString('base64')
}
const PREVIEW = png([90, 90, 90])
const FINAL = png([16, 185, 129])
const STEP_MS = 900

const jobs = new Map()
let next = 1

const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

const server = http.createServer((request, response) => {
  const url = request.url ?? ''
  if (request.method === 'GET' && url === '/sdcpp/v1/capabilities') {
    json(response, 200, { preview_modes: ['none', 'proj', 'tae', 'vae'] })
    return
  }
  if (request.method === 'POST' && url === '/sdcpp/v1/img_gen') {
    let raw = ''
    request.on('data', (chunk) => (raw += chunk))
    request.on('end', () => {
      const body = JSON.parse(raw || '{}')
      const id = `job_${next++}`
      const total = body.sample_params?.sample_steps ?? 4
      jobs.set(id, {
        started: Date.now(),
        total,
        preview: body.preview ?? 'none',
        cancelled: false
      })
      log('img_gen', { id, preview: body.preview ?? null, steps: total })
      json(response, 200, { id, status: 'queued', poll_url: `/sdcpp/v1/jobs/${id}` })
    })
    return
  }
  const cancel = url.match(/^\/sdcpp\/v1\/jobs\/([^/]+)\/cancel$/)
  if (request.method === 'POST' && cancel) {
    const job = jobs.get(cancel[1])
    if (job) job.cancelled = true
    json(response, 200, { ok: true })
    return
  }
  const poll = url.match(/^\/sdcpp\/v1\/jobs\/([^/]+)$/)
  if (request.method === 'GET' && poll) {
    const job = jobs.get(poll[1])
    if (!job) return json(response, 404, { error: { code: 'not_found', message: 'no such job' } })
    if (job.cancelled) return json(response, 200, { id: poll[1], status: 'cancelled', error: null })
    const step = Math.floor((Date.now() - job.started) / STEP_MS)
    if (step >= job.total) {
      return json(response, 200, {
        id: poll[1],
        status: 'completed',
        result: { output_format: 'png', images: [{ index: 0, b64_json: FINAL }] },
        error: null
      })
    }
    return json(response, 200, {
      id: poll[1],
      status: 'running',
      preview:
        job.preview === 'none' || step < 1
          ? null
          : { pass: 1, step, total_steps: job.total, b64_json: PREVIEW }
    })
  }
  json(response, 404, { error: { code: 'not_found', message: url } })
})

server.listen(port, '127.0.0.1', () => log('started', { port }))
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log('stopped', { signal })
    process.exit(0)
  })
}
