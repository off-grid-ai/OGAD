// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))

import { LoopbackMediaServer } from '../media-server'
import { localMediaRoots } from '../media-roots'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-media-server-'))
const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-media-resources-'))
const fixtures = {
  image: {
    dir: 'captures',
    name: 'capture.png',
    type: 'image/png',
    bytes: Buffer.from('PNG-BYTES')
  },
  video: {
    dir: 'meetings',
    name: 'meeting.mp4',
    type: 'video/mp4',
    bytes: Buffer.from('MP4-0123456789')
  },
  audio: { dir: 'voice', name: 'note.wav', type: 'audio/wav', bytes: Buffer.from('WAV-abcdefghij') }
} as const

const server = new LoopbackMediaServer({
  roots: localMediaRoots(profile, [resources]),
  port: 0,
  token: 'integration'
})

function fixturePath(key: keyof typeof fixtures): string {
  const fixture = fixtures[key]
  return path.join(profile, fixture.dir, fixture.name)
}

beforeAll(() => {
  for (const key of Object.keys(fixtures) as (keyof typeof fixtures)[]) {
    const fixture = fixtures[key]
    fs.mkdirSync(path.join(profile, fixture.dir), { recursive: true })
    fs.writeFileSync(fixturePath(key), fixture.bytes)
  }
  fs.mkdirSync(path.join(resources, 'style-thumbs'), { recursive: true })
  fs.writeFileSync(path.join(resources, 'style-thumbs', 'Photoreal.png'), fixtures.image.bytes)
})

afterAll(async () => {
  await server.close()
  fs.rmSync(profile, { recursive: true, force: true })
  fs.rmSync(resources, { recursive: true, force: true })
})

describe('loopback media server integration', () => {
  it('waits for readiness and serves real Replay image bytes over tokenized loopback HTTP (#88)', async () => {
    // No explicit start: urlFor must wait until the real TCP socket is listening.
    const url = await server.urlFor(fixturePath('image'))
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/m\/integration\//)

    const response = await fetch(url!)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe(fixtures.image.type)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(fixtures.image.bytes)
  })

  it('serves real video ranges with seekable 206 headers', async () => {
    const url = await server.urlFor(fixturePath('video'))
    const response = await fetch(url!, { headers: { Range: 'bytes=4-8' } })

    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Type')).toBe(fixtures.video.type)
    expect(response.headers.get('Content-Range')).toBe(`bytes 4-8/${fixtures.video.bytes.length}`)
    expect(response.headers.get('Accept-Ranges')).toBe('bytes')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(fixtures.video.bytes.subarray(4, 9))
  })

  it('serves real audio suffix ranges through the same service', async () => {
    const url = await server.urlFor(fixturePath('audio'))
    const response = await fetch(url!, { headers: { Range: 'bytes=-4' } })

    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Type')).toBe(fixtures.audio.type)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(fixtures.audio.bytes.subarray(-4))
  })

  it('serves a bundled style preview through the same admitted media path', async () => {
    const preview = path.join(resources, 'style-thumbs', 'Photoreal.png')
    const url = await server.urlFor(preview)
    const response = await fetch(url!)

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(fixtures.image.bytes)
  })

  it('does not issue URLs outside the media roots or for missing files', async () => {
    const outside = path.join(profile, 'memories.db')
    fs.writeFileSync(outside, 'private')

    await expect(server.urlFor(outside)).resolves.toBeNull()
    await expect(server.urlFor(path.join(profile, 'captures', 'missing.png'))).resolves.toBeNull()
  })
})

describe('LoopbackMediaServer — free-port fallback', () => {
  it('binds a DIFFERENT free port when the preferred one is already taken', async () => {
    const net = await import('node:net')
    // Occupy a port, then ask the media server to use THAT preferred port.
    const blocker = net.createServer()
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r))
    const taken = (blocker.address() as import('node:net').AddressInfo).port
    const media = new LoopbackMediaServer({
      roots: localMediaRoots(profile),
      port: taken,
      token: 't'
    })
    try {
      await media.start()
      // Fell back: bound a real, DIFFERENT port (not the occupied one) — and urlFor serves it.
      const url = await media.urlFor(fixturePath('image'))
      expect(url).toContain('http://127.0.0.1:')
      expect(url).not.toContain(`:${taken}/`)
    } finally {
      await media.close()
      await new Promise<void>((r) => blocker.close(() => r()))
    }
  })
})
