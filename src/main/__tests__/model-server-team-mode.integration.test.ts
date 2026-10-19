/**
 * The gateway's two modes over real HTTP. The only fake is llama-server itself: a loopback server
 * on the production port that streams slowly and holds each stream until the test lets it finish,
 * so the test sees exactly how many streams the gateway lets run at once.
 *
 * Single mode ("Just me") must behave as it always has: one stream at a time, `--parallel 1`.
 * Team mode opens llama-server slots, admits that many streams at once, queues the rest in order,
 * refuses the overflow with 429, frees a slot when a client disconnects, keeps remote models out of
 * the local line, and makes an image job's eviction wait for the streams in flight.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AddressInfo } from 'net'
import { LLAMA_SERVER_PORT } from '../../shared/ports'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-gateway-team-'))

vi.mock('electron', () => ({
  app: {
    getPath: () => TMP_DIR,
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getVersion: () => 'test'
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

interface HeldStream {
  label: string
  finish: () => void
  closed: boolean
}

let upstream: http.Server
let gatewayPort: number
let held: HeldStream[] = []
let running = 0
let peak = 0
const started: string[] = []
const disconnected: string[] = []
const previousDataDir = process.env.OFFGRID_DATA_DIR
let llm: typeof import('../llm').llm
let stopModelServer: typeof import('../model-server').stopModelServer

async function waitFor(check: () => boolean, what: string, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function unusedPort(): Promise<number> {
  const probe = http.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

/** A streamed chat through the gateway. Resolves with the status and the full reply text. */
function chat(
  label: string,
  init: { model?: string; signal?: AbortSignal; maxTokens?: number } = {}
): Promise<{ status: number; text: string; retryAfter: string | null }> {
  return fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: init.signal,
    body: JSON.stringify({
      ...(init.model ? { model: init.model } : {}),
      ...(init.maxTokens ? { max_tokens: init.maxTokens } : {}),
      stream: true,
      messages: [{ role: 'user', content: label }]
    })
  }).then(async (response) => ({
    status: response.status,
    text: await response.text(),
    retryAfter: response.headers.get('retry-after')
  }))
}

function finishNext(): void {
  const stream = held.find((entry) => !entry.closed)
  stream?.finish()
}

beforeAll(async () => {
  process.env.OFFGRID_DATA_DIR = TMP_DIR
  ;({ llm } = await import('../llm'))
  const gateway = await import('../model-server')
  stopModelServer = gateway.stopModelServer
  upstream = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404)
      res.end()
      return
    }
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const body = JSON.parse(raw) as { messages: { content: string }[] }
      const label = body.messages[0]!.content
      running += 1
      peak = Math.max(peak, running)
      started.push(label)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      // Slow tokens while held: a real stream, not one burst.
      const tick = setInterval(
        () => res.write(`data: {"choices":[{"delta":{"content":"."}}]}\n\n`),
        25
      )
      const entry: HeldStream = {
        label,
        closed: false,
        finish: () => {
          if (entry.closed) return
          entry.closed = true
          clearInterval(tick)
          running -= 1
          res.write(`data: {"choices":[{"delta":{"content":"${label} done"}}]}\n\n`)
          res.end('data: [DONE]\n\n')
        }
      }
      res.on('close', () => {
        if (entry.closed) return
        entry.closed = true
        clearInterval(tick)
        running -= 1
        disconnected.push(label)
      })
      held.push(entry)
    })
  })
  await new Promise<void>((resolve, reject) => {
    upstream.once('error', reject)
    upstream.listen(LLAMA_SERVER_PORT, '127.0.0.1', () => resolve())
  })
  gatewayPort = await unusedPort()
  await gateway.startModelServer(gatewayPort)
})

afterEach(async () => {
  for (const stream of held) stream.finish()
  await waitFor(() => running === 0, 'streams to end')
  held = []
  peak = 0
  started.length = 0
  disconnected.length = 0
})

afterAll(async () => {
  stopModelServer()
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDataDir
})

describe('single mode (Just me)', () => {
  it('launches llama-server with one slot and the person’s full context', async () => {
    await llm.setSettings({ gatewayMode: 'single' })
    const args = llm.launchArgs()
    expect(args[args.indexOf('--parallel') + 1]).toBe('1')
    expect(args).not.toContain('--kv-unified')
    expect(args).not.toContain('--metrics')
    expect(args[args.indexOf('-c') + 1]).toBe(String(llm.getSettings().ctxSize))
  })

  it('serves one stream at a time, as it always has', async () => {
    await llm.setSettings({ gatewayMode: 'single' })
    const replies = [chat('a'), chat('b')]
    await waitFor(() => started.length === 1, 'the first stream')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(running).toBe(1)
    finishNext()
    await waitFor(() => started.length === 2, 'the second stream')
    finishNext()
    const results = await Promise.all(replies)
    expect(results.map((r) => r.status)).toEqual([200, 200])
    expect(results[0]!.text).toContain('a done')
    expect(peak).toBe(1)
  })
})

describe('team mode', () => {
  // Each case starts from a fresh switch to team mode, as the Gateway screen does; before the
  // engine relaunches, the gateway sizes its line by the context rule alone.
  beforeEach(async () => {
    await llm.setSettings({ gatewayMode: 'single', gatewayClients: null })
    await llm.setSettings({ gatewayMode: 'team' })
  })

  it('serves a manual "requests at once" and clamps one above the safe maximum', async () => {
    const max = llm.gatewaySlotsMax()
    expect(llm.gatewaySlots()).toBe(max)
    await llm.setSettings({ gatewayClients: 2 })
    let args = llm.launchArgs()
    expect(args[args.indexOf('--parallel') + 1]).toBe('2')
    expect(llm.gatewaySlots()).toBe(2)
    // The gateway's line follows it: two streams run, the third waits.
    const replies = ['m0', 'm1', 'm2'].map((label) => chat(label))
    await waitFor(() => running === 2, 'two streams')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(running).toBe(2)
    finishNext()
    await waitFor(() => started.length === 3, 'the third stream')
    finishNext()
    finishNext()
    expect((await Promise.all(replies)).every((r) => r.status === 200)).toBe(true)

    await llm.setSettings({ gatewayClients: 99 })
    args = llm.launchArgs()
    expect(llm.gatewaySlots()).toBe(llm.gatewaySlotsMax())
    expect(args[args.indexOf('--parallel') + 1]).toBe(String(llm.gatewaySlotsMax()))
    expect(llm.getSettings()).toMatchObject({ gatewayClients: 99 })

    await llm.setSettings({ gatewayClients: null })
    expect(llm.getSettings()).toMatchObject({ gatewayClients: null })
  })

  it('launches llama-server with slots over one unified pool of at least the full context', async () => {
    await llm.setSettings({ gatewayMode: 'team' })
    const args = llm.launchArgs()
    // The slot count follows the memory free at launch; the gateway admits exactly that many.
    const slots = llm.gatewaySlots()
    expect(args[args.indexOf('--parallel') + 1]).toBe(String(slots))
    expect(args).toContain('--kv-unified')
    expect(args).toContain('--metrics')
    // The person's context is kept whole: one conversation may use all of it.
    expect(Number(args[args.indexOf('-c') + 1])).toBeGreaterThanOrEqual(llm.getSettings().ctxSize!)
    expect(llm.getSettings().gatewaySlots).toBe(slots)
  })

  it('runs one stream per slot at once and queues the next in order', async () => {
    const slots = llm.gatewaySlots()
    expect(slots).toBe(4)
    const labels = Array.from({ length: slots + 1 }, (_, i) => `s${i}`)
    const replies = labels.map((label) => chat(label))
    await waitFor(() => running === slots, `${slots} overlapping streams`)
    await new Promise((resolve) => setTimeout(resolve, 150))
    // The extra request waits its turn instead of starting a stream.
    expect(running).toBe(slots)
    expect(started).toHaveLength(slots)
    finishNext()
    await waitFor(() => started.length === slots + 1, 'the queued stream')
    for (let i = 0; i < slots; i++) finishNext()
    const results = await Promise.all(replies)
    expect(results.every((r) => r.status === 200)).toBe(true)
    expect(results[slots]!.text).toContain(`s${slots} done`)
    expect(peak).toBe(slots)
  })

  it('admits by tokens too: long replies that would overflow the shared pool wait', async () => {
    const pool = llm.gatewayPoolTokens()!
    // Each reply may take ~40% of the pool, so two fit beside each other and the third waits.
    const maxTokens = Math.floor(pool * 0.4)
    const replies = ['t0', 't1', 't2'].map((label) => chat(label, { maxTokens }))
    await waitFor(() => running === 2, 'two streams')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(running).toBe(2)
    expect(llm.gatewaySlots()).toBeGreaterThan(2)
    finishNext()
    await waitFor(() => started.length === 3, 'the third stream')
    finishNext()
    finishNext()
    expect((await Promise.all(replies)).every((r) => r.status === 200)).toBe(true)
  })

  it('refuses requests past the bounded queue with 429 and Retry-After', async () => {
    await llm.setSettings({ gatewayMode: 'team' })
    const slots = llm.gatewaySlots()
    const queueDepth = slots * 4
    const admitted = Array.from({ length: slots + queueDepth }, (_, i) => chat(`q${i}`))
    await waitFor(() => running === slots, 'the slots to fill')
    // Let the queued requests reach the gateway's line.
    await new Promise((resolve) => setTimeout(resolve, 200))
    const refused = await chat('overflow')
    expect(refused.status).toBe(429)
    expect(refused.retryAfter).toBe('2')
    expect(JSON.parse(refused.text)).toMatchObject({ error: { type: 'rate_limit_error' } })
    // Drain everything that was admitted.
    while (started.length < slots + queueDepth || running > 0) {
      finishNext()
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const results = await Promise.all(admitted)
    expect(results.every((r) => r.status === 200)).toBe(true)
  })

  it('frees the slot when a client disconnects, so a waiting request starts', async () => {
    await llm.setSettings({ gatewayMode: 'team' })
    const slots = llm.gatewaySlots()
    const leaving = new AbortController()
    const first = chat('leaver', { signal: leaving.signal }).catch((error: unknown) => error)
    await waitFor(() => started.includes('leaver'), 'the leaving stream')
    const others = Array.from({ length: slots }, (_, i) => chat(`w${i}`))
    await waitFor(() => running === slots, 'the slots to fill')
    expect(started).not.toContain(`w${slots - 1}`)
    leaving.abort()
    // llama-server sees the disconnect, and the waiter takes the freed slot.
    await waitFor(() => disconnected.includes('leaver'), 'llama-server to see the disconnect')
    await waitFor(() => started.includes(`w${slots - 1}`), 'the waiter to start')
    await first
    for (let i = 0; i < slots; i++) finishNext()
    expect((await Promise.all(others)).every((r) => r.status === 200)).toBe(true)
  })

  it('serves a remote model while every local slot is busy', async () => {
    await llm.setSettings({ gatewayMode: 'team' })
    const slots = llm.gatewaySlots()
    const remote = await import('../vision/remote-vision-server')
    const codec = await import('../../shared/remote-vision-server')
    const provider = http.createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ choices: [{ message: { content: 'remote answer' } }] }))
      })
    })
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
    const serverId = 'team-remote'
    try {
      remote.setRemoteVisionServerSettings({
        provider: 'custom',
        endpoint: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,
        model: 'remote-model',
        serverId,
        name: 'Remote'
      })
      const local = Array.from({ length: slots + 2 }, (_, i) => chat(`l${i}`))
      await waitFor(() => running === slots, 'the local slots to fill')
      const answer = await chat('remote', {
        model: codec.remoteVisionModelId(serverId, 'remote-model')
      })
      expect(answer.status).toBe(200)
      expect(answer.text).toContain('remote answer')
      // Every local stream is still running: the remote request did not wait behind them.
      expect(running).toBe(slots)
      while (started.length < slots + 2 || running > 0) {
        finishNext()
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      await Promise.all(local)
    } finally {
      remote.removeRemoteVisionServer(serverId)
      await new Promise<void>((resolve) => provider.close(() => resolve()))
    }
  })

  it('launches with the cache type the person chose, as single mode does', async () => {
    await llm.setSettings({ kvCacheType: 'q4_0' })
    try {
      const team = llm.launchArgs()
      expect(team[team.indexOf('--cache-type-k') + 1]).toBe('q4_0')
      expect(team[team.indexOf('--cache-type-v') + 1]).toBe('q4_0')
      await llm.setSettings({ gatewayMode: 'single' })
      const single = llm.launchArgs()
      expect(single[single.indexOf('--cache-type-v') + 1]).toBe('q4_0')
    } finally {
      await llm.setSettings({ kvCacheType: 'f16' })
    }
  })

  it('a client leaving a remote stream cancels it at the provider', async () => {
    const remote = await import('../vision/remote-vision-server')
    const codec = await import('../../shared/remote-vision-server')
    let providerClosed = false
    let providerStarted = false
    const provider = http.createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        providerStarted = true
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const tick = setInterval(() => response.write('data: {"choices":[{"delta":{"content":"."}}]}\n\n'), 25)
        response.on('close', () => {
          clearInterval(tick)
          providerClosed = true
        })
      })
    })
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
    const serverId = 'team-remote-cancel'
    try {
      remote.setRemoteVisionServerSettings({
        provider: 'custom',
        endpoint: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,
        model: 'remote-model',
        serverId,
        name: 'Remote'
      })
      const leaving = new AbortController()
      const reply = chat('remote leaver', {
        model: codec.remoteVisionModelId(serverId, 'remote-model'),
        signal: leaving.signal
      }).catch((error: unknown) => error)
      await waitFor(() => providerStarted, 'the provider stream')
      leaving.abort()
      await reply
      await waitFor(() => providerClosed, 'the provider to see the cancel')
    } finally {
      remote.removeRemoteVisionServer(serverId)
      provider.closeAllConnections()
      await new Promise<void>((resolve) => provider.close(() => resolve()))
    }
  })

  it('soak: 500 requests at 16 at once with random disconnects leave no slot, waiter or listener behind', async () => {
    const { teamLimiter } = await import('../model-server/team-runtimes')
    const limiter = teamLimiter('chat')
    // The fake engine answers at once here: the soak is about the gateway's bookkeeping. The
    // gateway's own line is what it controls: a client that leaves frees its turn when the
    // gateway's upstream request closes, which the engine may see a moment later, so the engine's
    // own count can briefly read one more (llama-server queues that request). The line never can.
    let peakInFlight = 0
    const autoFinish = setInterval(() => {
      peakInFlight = Math.max(peakInFlight, limiter.inFlight)
      for (const stream of held) if (!stream.closed && Math.random() < 0.5) stream.finish()
    }, 5)
    const heapBefore = process.memoryUsage().heapUsed
    const warnings: string[] = []
    const onWarning = (warning: Error): void => {
      warnings.push(warning.name)
    }
    process.on('warning', onWarning)
    let next = 0
    const statuses: (number | 'aborted')[] = []
    const worker = async (): Promise<void> => {
      while (next < 500) {
        const index = next++
        const leaving = new AbortController()
        if (index % 5 === 0) setTimeout(() => leaving.abort(), Math.floor(Math.random() * 60))
        statuses.push(
          await chat(`soak${index}`, { signal: leaving.signal }).then(
            (r) => r.status,
            () => 'aborted' as const
          )
        )
      }
    }
    try {
      await Promise.all(Array.from({ length: 16 }, () => worker()))
    } finally {
      clearInterval(autoFinish)
      process.off('warning', onWarning)
    }
    for (const stream of held) stream.finish()
    await waitFor(() => running === 0, 'the engine to be idle')
    await waitFor(() => limiter.inFlight === 0 && limiter.queued === 0, 'the line to drain')
    expect(statuses).toHaveLength(500)
    // Every request either finished or was left by its client; none was refused or failed (16
    // clients never overflow four slots and their line of sixteen).
    expect(statuses.every((status) => status === 200 || status === 'aborted')).toBe(true)
    expect(warnings).not.toContain('MaxListenersExceededWarning')
    expect(statuses.filter((status) => status === 200).length).toBeGreaterThan(300)
    expect(peakInFlight).toBeLessThanOrEqual(llm.gatewaySlots())
    // Bookkeeping stays flat: no growing heap from leaked streams (generous for GC timing).
    global.gc?.()
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(64 * 1024 * 1024)
  }, 60_000)

  it('makes an image job wait for the streams in flight before it evicts the chat model', async () => {
    await llm.setSettings({ gatewayMode: 'team' })
    const { modalityQueue, IMAGE_JOB } = await import('../modality-queue/queue')
    const { registerRuntime } = await import('../runtime-manager')
    registerRuntime(llm.runtime)
    const reply = chat('in-flight')
    await waitFor(() => running === 1, 'the stream')
    let imageStartedAt = 0
    const image = modalityQueue.run(IMAGE_JOB, async () => {
      imageStartedAt = Date.now()
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(imageStartedAt).toBe(0)
    const finishedAt = Date.now()
    finishNext()
    expect((await reply).text).toContain('in-flight done')
    await image
    expect(imageStartedAt).toBeGreaterThanOrEqual(finishedAt)
  })
})

describe('GET /v1/gateway/status', () => {
  type Line = { capacity: number | null; running: number | null; waiting: number | null; refused: number }
  async function status(): Promise<{ mode: string; slots: number; runtimes: Record<string, Line> }> {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/gateway/status`)
    expect(response.status).toBe(200)
    return (await response.json()) as { mode: string; slots: number; runtimes: Record<string, Line> }
  }

  it('in team mode, counts running, waiting and refused requests, and returns to zero after they drain', async () => {
    await llm.setSettings({ gatewayMode: 'single', gatewayClients: null })
    await llm.setSettings({ gatewayMode: 'team' })
    const slots = llm.gatewaySlots()
    const before = (await status()).runtimes.chat!.refused
    const admitted = Array.from({ length: slots + slots * 4 }, (_, i) => chat(`st${i}`))
    await waitFor(() => running === slots, 'the slots to fill')
    await new Promise((resolve) => setTimeout(resolve, 200))
    const busy = await status()
    expect(busy).toMatchObject({ mode: 'team', slots })
    expect(busy.runtimes.chat).toMatchObject({ capacity: slots, running: slots, waiting: slots * 4 })
    // Every runtime has a line.
    for (const runtime of ['remote', 'grounder', 'decision', 'kev', 'image', 'transcription', 'speech', 'embeddings'])
      expect(busy.runtimes[runtime]).toBeDefined()
    expect((await chat('one too many')).status).toBe(429)
    expect((await status()).runtimes.chat!.refused).toBe(before + 1)
    while (started.length < slots + slots * 4 || running > 0) {
      finishNext()
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await Promise.all(admitted)
    await waitFor(() => running === 0, 'the engine to be idle')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect((await status()).runtimes.chat).toMatchObject({ running: 0, waiting: 0, refused: before + 1 })
  })

  it('in single mode, shows chat taking its one turn at a time', async () => {
    await llm.setSettings({ gatewayMode: 'single' })
    const replies = [chat('sa'), chat('sb')]
    await waitFor(() => started.length === 1, 'the first stream')
    await new Promise((resolve) => setTimeout(resolve, 150))
    const busy = await status()
    expect(busy).toMatchObject({ mode: 'single', slots: 1 })
    expect(busy.runtimes.chat).toMatchObject({ capacity: 1, running: 1, waiting: 1, refused: 0 })
    expect(busy.runtimes.transcription).toMatchObject({ capacity: null })
    finishNext()
    await waitFor(() => started.length === 2, 'the second stream')
    finishNext()
    await Promise.all(replies)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect((await status()).runtimes.chat).toMatchObject({ running: 0, waiting: 0 })
  })
})

describe('the request log names the API key that sent each request', () => {
  it('records the key\'s name with a key, and nothing without one', async () => {
    await llm.setSettings({ gatewayMode: 'single' })
    const store = await import('../ai-request-log-store')
    const gateway = await import('../model-server')
    store.initializeAIRequestLogs()
    const send = async (label: string, key?: string): Promise<number> => {
      const reply = fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { Authorization: `Bearer ${key}` } : {})
        },
        body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: label }] })
      })
      await waitFor(() => started.includes(label), `the ${label} stream`)
      finishNext()
      const response = await reply
      await response.text()
      return response.status
    }
    const logged = async (label: string): Promise<{ keyName?: string }> => {
      await store.flushAIRequestLogs()
      const row = store.listAIRequestLogs({ search: label }).rows.find((r) => r.preview.includes(label))
      expect(row).toBeDefined()
      return row!
    }
    const { key } = gateway.createGatewayApiKey('laptop', null)
    try {
      expect(await send('keyed-request', key)).toBe(200)
      expect((await logged('keyed-request')).keyName).toBe('laptop')
      gateway.setGatewayApiKeyRequired(false)
      expect(await send('open-request')).toBe(200)
      expect(await logged('open-request')).not.toHaveProperty('keyName')
    } finally {
      gateway.setGatewayApiKeyRequired(false)
    }
  })
})

describe('a headless Team server', () => {
  it('serves the launch flags for this run and keeps the saved settings', async () => {
    const { parseGatewayLaunchOverride } = await import('@offgrid/models')
    await llm.setSettings({ gatewayMode: 'single', gatewayClients: null })
    const { invalid, ...chosen } = parseGatewayLaunchOverride(['--gateway-mode', 'team'], {
      OFFGRID_GATEWAY_CLIENTS: '2'
    })
    expect(invalid).toEqual([])
    llm.setGatewayLaunchOverride(chosen)
    expect(llm.gatewayMode()).toBe('team')
    const args = llm.launchArgs()
    expect(args[args.indexOf('--parallel') + 1]).toBe('2')
    // Saved settings are the person's, not this run's.
    expect(llm.getSettings()).toMatchObject({ gatewayMode: 'single', gatewayClients: null })
    // The gateway serves two at once, as the flags asked.
    const replies = ['h0', 'h1', 'h2'].map((label) => chat(label))
    await waitFor(() => running === 2, 'two streams')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(running).toBe(2)
    while (started.length < 3 || running > 0) {
      finishNext()
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect((await Promise.all(replies)).every((r) => r.status === 200)).toBe(true)
    // A setting the person changes takes over from the flag.
    await llm.setSettings({ gatewayMode: 'single' })
    expect(llm.gatewayMode()).toBe('single')
    expect(llm.gatewayClients()).toBe(2)
    await llm.setSettings({ gatewayClients: null })
    expect(llm.gatewayClients()).toBeNull()
  })

  it('keeps the machine awake while it serves, and lets it sleep in single mode and when it stops', async () => {
    const gateway = await import('../model-server')
    const events: string[] = []
    let next = 0
    gateway.setGatewayPowerBlocker({
      start: (type) => {
        events.push(`start ${type}`)
        return ++next
      },
      stop: (id) => events.push(`stop ${id}`)
    })
    try {
      await llm.setSettings({ gatewayMode: 'team' })
      const first = chat('awake')
      await waitFor(() => running === 1, 'the stream')
      expect(events).toEqual(['start prevent-app-suspension'])
      finishNext()
      await first
      // Still awake for a grace period after the last request.
      expect(events).toEqual(['start prevent-app-suspension'])
      await llm.setSettings({ gatewayMode: 'single' })
      expect(events).toEqual(['start prevent-app-suspension', 'stop 1'])
      // Single mode never holds it.
      const single = chat('single')
      await waitFor(() => running === 1, 'the single stream')
      finishNext()
      await single
      expect(events).toHaveLength(2)
      // Team again, and the gateway stops while serving.
      await llm.setSettings({ gatewayMode: 'team' })
      const last = chat('stopping').catch(() => null)
      await waitFor(() => running === 1, 'the last stream')
      expect(events.at(-1)).toBe('start prevent-app-suspension')
      gateway.stopModelServer()
      expect(events.at(-1)).toBe('stop 2')
      finishNext()
      await last
    } finally {
      gateway.setGatewayPowerBlocker(null)
      await llm.setSettings({ gatewayMode: 'single' })
    }
  })
})
