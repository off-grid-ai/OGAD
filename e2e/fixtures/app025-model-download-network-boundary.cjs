/**
 * Hugging Face delivery boundary for APP-025.
 *
 * The first response is a complete-but-corrupt staged payload. The retry receives a real GGUF
 * from the host's verified local fixture. Off Grid still owns catalog resolution, download queue,
 * progress, Range retry, integrity checks, filesystem promotion, activation, and the model runtime.
 */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- Electron loads this CommonJS bootstrap before the production bundle. */
const fs = require('node:fs')
const path = require('node:path')

const ledgerPath = process.env.OFFGRID_APP025_NETWORK_LEDGER
const sourceModel = process.env.OFFGRID_APP025_REAL_GGUF
const sourceProjector = process.env.OFFGRID_APP025_REAL_MMPROJ
if (!ledgerPath || !sourceModel || !sourceProjector) {
  throw new Error('APP-025 network ledger, real GGUF, and real projector sources are required')
}

const record = (event, details = {}) => {
  fs.appendFileSync(ledgerPath, `${JSON.stringify({ event, ...details })}\n`)
}
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function bufferBody(buffer, attempt, chunkSize, delayMs) {
  let offset = 0
  return new ReadableStream({
    async pull(controller) {
      await delay(delayMs)
      if (offset >= buffer.length) {
        record('payload-complete', { attempt, bytes: offset })
        controller.close()
        return
      }
      const end = Math.min(buffer.length, offset + chunkSize)
      const chunk = buffer.subarray(offset, end)
      offset = end
      controller.enqueue(chunk)
      record('payload-chunk', { attempt, bytes: offset, totalBytes: buffer.length })
    }
  })
}

function fileBody(filePath, attempt, chunkSize, delayMs) {
  const size = fs.statSync(filePath).size
  const descriptor = fs.openSync(filePath, 'r')
  let offset = 0
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    fs.closeSync(descriptor)
  }
  return {
    size,
    body: new ReadableStream({
      async pull(controller) {
        await delay(delayMs)
        if (offset >= size) {
          close()
          record('payload-complete', { attempt, bytes: offset })
          controller.close()
          return
        }
        const length = Math.min(chunkSize, size - offset)
        const chunk = Buffer.allocUnsafe(length)
        const bytesRead = fs.readSync(descriptor, chunk, 0, length, offset)
        if (bytesRead <= 0) {
          close()
          controller.error(new Error('APP-025 source model ended unexpectedly'))
          return
        }
        offset += bytesRead
        controller.enqueue(chunk.subarray(0, bytesRead))
        record('payload-chunk', { attempt, bytes: offset, totalBytes: size })
      },
      cancel() {
        close()
        record('payload-cancelled', { attempt, bytes: offset })
      }
    })
  }
}

const originalFetch = globalThis.fetch.bind(globalThis)
let requestCount = 0
globalThis.fetch = async (input, init) => {
  const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const isPrimary = target.includes('/Qwen3.5-2B-Q4_K_M.gguf')
  const isProjector = target.includes('/mmproj-BF16.gguf')
  if (!isPrimary && !isProjector) {
    return originalFetch(input, init)
  }

  requestCount += 1
  const attempt = requestCount
  const range = new Headers(init?.headers).get('range')
  record('model-request', { attempt, target, range })

  if (isPrimary && attempt === 1) {
    const corrupt = Buffer.alloc(256 * 1024, 0xa5)
    corrupt.write('NOPE', 0, 'ascii')
    record('model-response', { attempt, kind: 'corrupt', totalBytes: corrupt.length })
    return new Response(bufferBody(corrupt, attempt, 32 * 1024, 500), {
      status: 200,
      headers: { 'content-length': String(corrupt.length) }
    })
  }

  // Ignore Range intentionally (a valid HTTP 200 means restart from byte zero). The production
  // downloader must replace, not append to, the corrupt .part before verifying and promoting it.
  const source = isProjector ? sourceProjector : sourceModel
  const delivery = fileBody(source, attempt, 8 * 1024 * 1024, 20)
  record('model-response', {
    attempt,
    kind: isProjector ? 'valid-mmproj' : 'valid-gguf',
    totalBytes: delivery.size
  })
  return new Response(delivery.body, {
    status: 200,
    headers: { 'content-length': String(delivery.size) }
  })
}

const electron = require('electron')
electron.app.setAppPath(path.resolve(__dirname, '../..'))
electron.app.setPath('userData', process.env.OFFGRID_USER_DATA)
record('fixture-ready', { pid: process.pid })
require('../../out/main/index.js')
