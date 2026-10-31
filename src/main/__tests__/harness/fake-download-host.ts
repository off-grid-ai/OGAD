// The network boundary for download tests: a real HTTP server on loopback that serves files with
// standard Range semantics, plus a fetch that routes a pinned https origin (which product code
// insists on) to it, the way DNS would. Product code sends real requests over a real socket; the
// test reads what the host saw instead of counting calls on a stub.
import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface HostedFile {
  bytes: Buffer
  /** How the host answers a Range request: honestly (206), with 416, or with a wrong range. */
  range?: 'honest' | 'refuse-416' | 'wrong-range'
}

export interface DownloadRequest {
  path: string
  range: string | null
}

export interface FakeDownloadHost {
  origin: string
  requests: DownloadRequest[]
  /** A fetch that sends `pinnedOrigin` to this host and every other request to the real fetch. */
  fetchFor(pinnedOrigin: string): typeof globalThis.fetch
  close(): Promise<void>
}

export async function startFakeDownloadHost(
  files: Record<string, HostedFile>
): Promise<FakeDownloadHost> {
  const requests: DownloadRequest[] = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://host')
    const range = req.headers.range ?? null
    requests.push({ path: url.pathname, range })
    const file = files[url.pathname]
    if (!file) {
      res.writeHead(404).end()
      return
    }
    const total = file.bytes.length
    const match = range ? /^bytes=(\d+)-$/.exec(range) : null
    if (!match) {
      res.writeHead(200, { 'Content-Length': total }).end(file.bytes)
      return
    }
    const start = Number(match[1])
    if (file.range === 'refuse-416' || start >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` }).end()
      return
    }
    const claimed = file.range === 'wrong-range' ? 0 : start
    res
      .writeHead(206, {
        'Content-Range': `bytes ${claimed}-${total - 1}/${total}`,
        'Content-Length': total - start
      })
      .end(file.bytes.subarray(start))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const realFetch = globalThis.fetch.bind(globalThis)
  return {
    origin,
    requests,
    fetchFor: (pinnedOrigin) =>
      ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const target = typeof input === 'string' || input instanceof URL ? String(input) : input.url
        return realFetch(
          target.startsWith(pinnedOrigin) ? origin + target.slice(pinnedOrigin.length) : input,
          init
        )
      }) as typeof globalThis.fetch,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
