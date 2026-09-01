// D2 — a finished download must be verified before it's promoted to installed.
// A truncated file (server closed early) or a corrupt GGUF used to be renamed to
// its final name and marked installed, then llama-server died on load with a blank
// "Chat model Down". downloadIntegrityError is the gate; the loop throws on it
// instead of renaming.

import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { sha256File, verifyDownloadedPart } from '../download-verify'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-dlverify-'))
const write = (name: string, buf: Buffer): string => {
  const p = path.join(TMP, name)
  fs.writeFileSync(p, buf)
  return p
}
const validGguf = Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2000)]) // magic + >1024 bytes
afterAll(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

describe('verifyDownloadedPart (D2)', () => {
  it('rejects a truncated download (written < the server-reported total)', async () => {
    const p = write('model.gguf', validGguf)
    expect(await verifyDownloadedPart('model.gguf', 1500, 3000, p)).toMatch(/incomplete/)
  })

  it('rejects a corrupt GGUF (wrong magic) even when the byte count matches', async () => {
    const bad = write('bad.gguf', Buffer.concat([Buffer.from('XXXX'), Buffer.alloc(2000)]))
    expect(await verifyDownloadedPart('bad.gguf', 2004, 2004, bad)).toMatch(/not a valid GGUF/)
  })

  it('rejects a GGUF that is under the minimum size', async () => {
    const tiny = write('tiny.gguf', Buffer.from('GGUF'))
    expect(await verifyDownloadedPart('tiny.gguf', 4, 4, tiny)).toMatch(/not a valid GGUF/)
  })

  it('passes a complete, valid GGUF', async () => {
    const p = write('good.gguf', validGguf)
    expect(await verifyDownloadedPart('good.gguf', validGguf.length, validGguf.length, p)).toBeNull()
  })

  it('passes a complete non-GGUF file (no magic check applies)', async () => {
    const p = write('tokenizer.json', Buffer.alloc(50))
    expect(await verifyDownloadedPart('tokenizer.json', 50, 50, p)).toBeNull()
  })

  it('passes when the server gave no length (total = 0) and the file is fine', async () => {
    const p = write('nolen.bin', Buffer.alloc(10))
    expect(await verifyDownloadedPart('nolen.bin', 10, 0, p)).toBeNull()
  })
})

describe('sha256 content verification', () => {
  const sha = (buf: Buffer): string => crypto.createHash('sha256').update(buf).digest('hex')

  it('sha256File computes the real digest of the file on disk', async () => {
    const buf = Buffer.from('the quick brown fox')
    const p = write('hashme.bin', buf)
    expect(await sha256File(p)).toBe(sha(buf))
  })

  it('passes when the downloaded bytes match the expected hash', async () => {
    const buf = Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(4096, 7)])
    const p = write('good.gguf', buf)
    expect(await verifyDownloadedPart('good.gguf', buf.length, buf.length, p, sha(buf))).toBeNull()
  })

  it('flags a mismatch when the bytes are corrupt (right length, wrong content)', async () => {
    const expected = Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(4096, 7)])
    const corrupted = Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(4096, 9)])
    const p = write('bad.gguf', corrupted) // same length, different bytes
    const err = await verifyDownloadedPart('bad.gguf', corrupted.length, corrupted.length, p, sha(expected))
    expect(err).toMatch(/checksum mismatch/i)
  })

  it('is case-insensitive on the expected hex', async () => {
    const buf = Buffer.from('abc')
    const p = write('case.bin', buf)
    expect(await verifyDownloadedPart('case.bin', buf.length, buf.length, p, sha(buf).toUpperCase())).toBeNull()
  })

  it('skips verification when no expected hash is known (opt-in)', async () => {
    const p = write('nohash.gguf', validGguf)
    expect(await verifyDownloadedPart('nohash.gguf', validGguf.length, validGguf.length, p)).toBeNull()
  })
})
