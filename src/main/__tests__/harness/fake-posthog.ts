import http from 'node:http'
import { gunzipSync } from 'node:zlib'
import type { AddressInfo } from 'node:net'

export interface ReceivedEvent {
  event: string
  distinctId: string
  properties: Record<string, unknown>
}

export interface FakePostHog {
  /** The host to give the client, on loopback so the offline harness lets it through. */
  host: string
  events: ReceivedEvent[]
  /** Raw request bodies as sent, to check that nothing on the never-send list appears anywhere. */
  bodies: string[]
  close(): Promise<void>
}

/**
 * A contract-faithful stand-in for PostHog's ingestion endpoint (`POST /batch/`, optionally
 * gzip-compressed, answering 200). It is the network boundary: the real SDK talks to it.
 */
export async function startFakePostHog(): Promise<FakePostHog> {
  const events: ReceivedEvent[] = []
  const bodies: string[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      let raw = Buffer.concat(chunks)
      if (req.headers['content-encoding'] === 'gzip') raw = gunzipSync(raw)
      const text = raw.toString('utf8')
      bodies.push(text)
      try {
        const payload = JSON.parse(text) as {
          batch?: { event: string; distinct_id: string; properties: Record<string, unknown> }[]
        }
        for (const item of payload.batch ?? []) {
          events.push({
            event: item.event,
            distinctId: item.distinct_id,
            properties: item.properties
          })
        }
      } catch {
        /* recorded in bodies */
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"status":1}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    host: `http://127.0.0.1:${port}`,
    events,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
