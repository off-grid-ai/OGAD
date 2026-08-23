// Tiny loopback HTTP server for local media (meeting recordings, uploads).
//
// Why this exists: serving large seekable video to a <video> element through
// Electron's custom `ogcapture://` protocol + a ReadableStream body proved racy —
// Chromium's media stack cancels range requests aggressively to manage its buffer,
// and the protocol→ReadableStream bridge never recovers (every non-zero-offset
// range delivered 0 bytes and looped). Serving the same file over plain HTTP with
// Node's `fs.createReadStream(...).pipe(res)` is the battle-tested path every video
// on the web uses: real sockets, real Range/206, real cancel/reconnect.
//
// Bound to 127.0.0.1 ONLY (never the LAN), with a per-launch token in the path and
// a strict allowlist of root dirs, so it can't be used to read arbitrary files.

import http from 'http'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { app } from 'electron'
import { parseRange, isPathAllowed } from './media-range'
import { MEDIA_PORT } from '../shared/ports'
import { pickFreePort } from './free-port'
import { mimeForExt } from './mime'
import { localMediaRoots } from './media-roots'
import { resourceDirs } from './runtime-env'

// Fixed loopback port so the renderer CSP (media-src) can allowlist it. Bound to
// 127.0.0.1 only — not reachable off-device. Canonical value in shared/ports.

/** Resolve symlinks + `..` to a canonical absolute path; null if it can't (e.g. missing). */
function canonical(p: string): string | null {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return null
  }
}

export interface LoopbackMediaServerOptions {
  roots: string[]
  /** Use `0` when the operating system should allocate an isolated test port. */
  port?: number
  token?: string
}

/**
 * Owns one loopback server, including readiness, URL admission, and shutdown.
 * Callers receive URLs only after the socket is listening, which removes the
 * startup race where the first Replay frame permanently received `null`.
 */
export class LoopbackMediaServer {
  private server: http.Server | null = null
  private startPromise: Promise<void> | null = null
  private boundPort = 0
  private readonly token: string
  private readonly roots: string[]
  private readonly requestedPort: number

  constructor(options: LoopbackMediaServerOptions) {
    this.token = options.token ?? randomUUID().replace(/-/g, '')
    this.requestedPort = options.port ?? MEDIA_PORT
    this.roots = options.roots.map((root) => canonical(root) ?? path.resolve(root))
  }

  start(): Promise<void> {
    if (this.boundPort > 0) return Promise.resolve()
    if (this.startPromise) return this.startPromise
    this.startPromise = this.listenOnFreePort()
    return this.startPromise
  }

  private async listenOnFreePort(): Promise<void> {
    // The preferred media port (MEDIA_PORT) may be taken by another Off Grid AI Desktop instance; scan upward
    // for a free one. requestedPort 0 = let the OS assign (tests) — inherently free. urlFor() serves
    // the LIVE boundPort, so downstream links follow wherever it bound.
    const target =
      this.requestedPort > 0 ? ((await pickFreePort(this.requestedPort)) ?? this.requestedPort) : 0
    const candidate = http.createServer((req, res) => this.handle(req, res))
    this.server = candidate
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error): void => {
        if (this.server === candidate) {
          this.server = null
          this.boundPort = 0
        }
        this.startPromise = null
        reject(error)
      }
      candidate.once('error', fail)
      candidate.listen(target, '127.0.0.1', () => {
        candidate.off('error', fail)
        candidate.on('error', (error) => console.error('[media-server]', error))
        const address = candidate.address()
        if (!address || typeof address === 'string') {
          candidate.close()
          fail(new Error('Loopback media server did not receive a TCP port.'))
          return
        }
        this.boundPort = address.port
        this.startPromise = null
        resolve()
      })
    })
  }

  async urlFor(absPath: string): Promise<string | null> {
    if (!absPath) return null
    await this.start()
    const real = canonical(absPath)
    if (!real || !isPathAllowed(real, this.roots)) return null
    const encoded = Buffer.from(real, 'utf8').toString('base64url')
    return `http://127.0.0.1:${this.boundPort}/m/${this.token}/${encoded}`
  }

  async close(): Promise<void> {
    const active = this.server
    this.server = null
    this.boundPort = 0
    this.startPromise = null
    if (!active) return
    await new Promise<void>((resolve, reject) => {
      active.close((error) => (error ? reject(error) : resolve()))
    })
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url || '/'
    const prefix = `/m/${this.token}/`
    if (!url.startsWith(prefix)) {
      res.writeHead(403).end()
      return
    }

    let filePath: string
    try {
      const encoded = url.slice(prefix.length).split('?')[0]!
      filePath = Buffer.from(decodeURIComponent(encoded), 'base64url').toString('utf8')
    } catch {
      res.writeHead(400).end()
      return
    }

    const real = canonical(filePath)
    if (!real || !isPathAllowed(real, this.roots)) {
      res.writeHead(real ? 403 : 404).end()
      return
    }
    serveFile(req, res, real)
  }
}

let productionServer: LoopbackMediaServer | null = null

function serveFile(req: http.IncomingMessage, res: http.ServerResponse, filePath: string): void {
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch {
    res.writeHead(404).end()
    return
  }
  if (!stat.isFile()) {
    res.writeHead(404).end()
    return
  }
  const size = stat.size
  const type = mimeForExt(path.extname(filePath))
  const r = parseRange(req.headers.range, size)

  if (r.unsatisfiable) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
    return
  }
  if (!r.full) {
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': r.end - r.start + 1,
      'Content-Range': `bytes ${r.start}-${r.end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    })
    const rs = fs.createReadStream(filePath, { start: r.start, end: r.end })
    rs.on('error', () => res.destroy())
    rs.pipe(res)
    return
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store'
  })
  const rs = fs.createReadStream(filePath)
  rs.on('error', () => res.destroy())
  rs.pipe(res)
}

/** Start the loopback media server (idempotent). Call after app is ready. */
export function startMediaServer(): void {
  productionServer ??= new LoopbackMediaServer({
    roots: localMediaRoots(app.getPath('userData'), resourceDirs()),
    port: MEDIA_PORT
  })
  void productionServer.start().catch((error) => console.error('[media-server]', error))
}

/** Build a loopback URL only after the production socket is ready. */
export async function mediaUrlFor(absPath: string): Promise<string | null> {
  if (!productionServer) return null
  try {
    return await productionServer.urlFor(absPath)
  } catch (error) {
    console.error('[media-server]', error)
    return null
  }
}

/** Stop the production listener and release its port. Safe before start and on
 * repeated shutdown calls. */
export async function stopMediaServer(): Promise<void> {
  const active = productionServer
  productionServer = null
  await active?.close()
}
