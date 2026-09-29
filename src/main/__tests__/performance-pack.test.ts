import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const fixture = vi.hoisted(() => ({ root: '', driver: true }))

vi.mock('../runtime-env', () => ({
  dataDir: () => fixture.root,
  resourceFile: () => path.join(fixture.root, 'performance-packs.json')
}))
vi.mock('../transcription/whisper-runtime', () => ({
  hasLinuxNvidiaDriver: () => fixture.driver,
  hasWindowsNvidiaDriver: () => fixture.driver
}))

const version = 'test-v1'
const url = `https://runtime.getoffgridai.co/desktop/cuda/linux/${version}.tar.gz`
let originalPlatform: PropertyDescriptor | undefined

function archive(): Buffer {
  const source = path.join(fixture.root, 'source', 'bin', 'llama-cuda')
  fs.mkdirSync(source, { recursive: true })
  fs.writeFileSync(path.join(source, 'llama-server'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const output = path.join(fixture.root, 'source.tar.gz')
  const result = spawnSync('tar', ['-czf', output, '-C', path.join(fixture.root, 'source'), 'bin'])
  expect(result.status).toBe(0)
  return fs.readFileSync(output)
}

function manifest(bytes: Buffer, digest = createHash('sha256').update(bytes).digest('hex')): void {
  fs.writeFileSync(path.join(fixture.root, 'performance-packs.json'), JSON.stringify({
    schemaVersion: 1,
    cuda: { linux: { url, sha256: digest, bytes: bytes.length, version } }
  }))
}

async function settled(phase: 'installed' | 'failed'): Promise<Awaited<ReturnType<typeof import('../performance-pack')['performancePackStatus']>>> {
  const { performancePackStatus } = await import('../performance-pack')
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = performancePackStatus()
    if (status.phase === phase) return status
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Performance pack did not reach ${phase}`)
}

beforeEach(() => {
  vi.resetModules()
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'ogad-pack-test-'))
  fixture.driver = true
  originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.OFFGRID_PERFORMANCE_PACK_BIN
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
  fs.rmSync(fixture.root, { recursive: true, force: true })
})

describe('optional NVIDIA performance pack', () => {
  it('offers no download without a pinned manifest or an NVIDIA driver', async () => {
    const pack = await import('../performance-pack')
    expect(pack.performancePackStatus().phase).toBe('unavailable')
    const bytes = archive()
    manifest(bytes)
    fixture.driver = false
    expect(pack.performancePackStatus().phase).toBe('not-needed')
    expect(pack.startPerformancePack().phase).toBe('not-needed')
  })

  it('rejects a manifest that points outside the approved download host', async () => {
    const bytes = archive()
    manifest(bytes)
    const manifestPath = path.join(fixture.root, 'performance-packs.json')
    const contents = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    contents.cuda.linux.url = 'https://example.com/untrusted.tar.gz'
    fs.writeFileSync(manifestPath, JSON.stringify(contents))
    const pack = await import('../performance-pack')
    expect(pack.performancePackStatus().phase).toBe('unavailable')
  })

  it('checks the hash, installs the archive, and activates the verified bin root', async () => {
    const bytes = archive()
    manifest(bytes)
    const fetcher = vi.fn(async () => new Response(new Uint8Array(bytes), { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    const pack = await import('../performance-pack')
    expect(pack.performancePackStatus().phase).toBe('available')
    expect(pack.startPerformancePack().phase).toBe('downloading')
    const status = await settled('installed')
    expect(status.downloadedBytes).toBe(bytes.length)
    expect(status.restartRequired).toBe(true)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fs.existsSync(path.join(process.env.OFFGRID_PERFORMANCE_PACK_BIN!, 'llama-cuda', 'llama-server'))).toBe(true)
    expect(pack.startPerformancePack().phase).toBe('installed')
    vi.resetModules()
    const afterRestart = await import('../performance-pack')
    expect(afterRestart.performancePackStatus().restartRequired).toBe(false)
  })

  it('rejects an archive with the wrong hash and removes the partial file', async () => {
    const bytes = archive()
    manifest(bytes, '0'.repeat(64))
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array(bytes), { status: 200 }))
    const pack = await import('../performance-pack')
    pack.startPerformancePack()
    const status = await settled('failed')
    expect(status.error).toMatch(/hash check/)
    expect(process.env.OFFGRID_PERFORMANCE_PACK_BIN).toBeUndefined()
    expect(fs.readdirSync(path.join(fixture.root, 'performance-packs'))).toEqual([])
  })

  it('resumes a partial download only from the requested byte', async () => {
    const bytes = archive()
    const hash = createHash('sha256').update(bytes).digest('hex')
    manifest(bytes, hash)
    const packRoot = path.join(fixture.root, 'performance-packs', `cuda-${version}-${hash.slice(0, 12)}`)
    fs.mkdirSync(path.dirname(packRoot), { recursive: true })
    const prefix = Math.floor(bytes.length / 2)
    fs.writeFileSync(`${packRoot}.tar.gz.part`, bytes.subarray(0, prefix))
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
      expect(options.headers).toEqual({ Range: `bytes=${prefix}-` })
      return new Response(new Uint8Array(bytes.subarray(prefix)), {
        status: 206,
        headers: { 'Content-Range': `bytes ${prefix}-${bytes.length - 1}/${bytes.length}` }
      })
    })
    vi.stubGlobal('fetch', fetcher)
    const pack = await import('../performance-pack')
    pack.startPerformancePack()
    expect((await settled('installed')).bytes).toBe(bytes.length)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('rejects a response with the wrong resume range', async () => {
    const bytes = archive()
    const hash = createHash('sha256').update(bytes).digest('hex')
    manifest(bytes, hash)
    const packRoot = path.join(fixture.root, 'performance-packs', `cuda-${version}-${hash.slice(0, 12)}`)
    fs.mkdirSync(path.dirname(packRoot), { recursive: true })
    const prefix = Math.floor(bytes.length / 2)
    fs.writeFileSync(`${packRoot}.tar.gz.part`, bytes.subarray(0, prefix))
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array(bytes.subarray(prefix)), {
      status: 206,
      headers: { 'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}` }
    }))
    const pack = await import('../performance-pack')
    pack.startPerformancePack()
    expect((await settled('failed')).error).toMatch(/invalid resume range/)
    expect(fs.statSync(`${packRoot}.tar.gz.part`).size).toBe(prefix)
  })
})
