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
    expect(
      await verifyDownloadedPart({
        name: 'model.gguf',
        writtenBytes: 1500,
        responseTotalBytes: 3000,
        partPath: p
      })
    ).toMatch(/incomplete/)
    expect(fs.existsSync(p)).toBe(true)
  })

  it('deletes a corrupt GGUF so retry starts from byte zero', async () => {
    const bad = write('bad.gguf', Buffer.concat([Buffer.from('XXXX'), Buffer.alloc(2000)]))
    expect(
      await verifyDownloadedPart({
        name: 'bad.gguf',
        writtenBytes: 2004,
        responseTotalBytes: 2004,
        partPath: bad
      })
    ).toMatch(/not a valid GGUF/)
    expect(fs.existsSync(bad)).toBe(false)
  })

  it('rejects a GGUF that is under the minimum size', async () => {
    const tiny = write('tiny.gguf', Buffer.from('GGUF'))
    expect(
      await verifyDownloadedPart({
        name: 'tiny.gguf',
        writtenBytes: 4,
        responseTotalBytes: 4,
        partPath: tiny
      })
    ).toMatch(/not a valid GGUF/)
    expect(fs.existsSync(tiny)).toBe(false)
  })

  it('deletes a completed file whose size does not match the catalog manifest', async () => {
    const wrongSize = write('wrong-size.gguf', validGguf)
    expect(
      await verifyDownloadedPart({
        name: 'wrong-size.gguf',
        writtenBytes: validGguf.length,
        responseTotalBytes: validGguf.length,
        partPath: wrongSize,
        expectedBytes: validGguf.length + 1
      })
    ).toMatch(/does not match the manifest/)
    expect(fs.existsSync(wrongSize)).toBe(false)
  })

  it('passes a complete, valid GGUF', async () => {
    const p = write('good.gguf', validGguf)
    expect(
      await verifyDownloadedPart({
        name: 'good.gguf',
        writtenBytes: validGguf.length,
        responseTotalBytes: validGguf.length,
        partPath: p
      })
    ).toBeNull()
  })

  it('passes a complete non-GGUF file (no magic check applies)', async () => {
    const p = write('tokenizer.json', Buffer.alloc(50))
    expect(
      await verifyDownloadedPart({
        name: 'tokenizer.json',
        writtenBytes: 50,
        responseTotalBytes: 50,
        partPath: p
      })
    ).toBeNull()
  })

  it('passes when the server gave no length (total = 0) and the file is fine', async () => {
    const p = write('nolen.bin', Buffer.alloc(10))
    expect(
      await verifyDownloadedPart({
        name: 'nolen.bin',
        writtenBytes: 10,
        responseTotalBytes: 0,
        partPath: p
      })
    ).toBeNull()
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
    expect(
      await verifyDownloadedPart({
        name: 'good.gguf',
        writtenBytes: buf.length,
        responseTotalBytes: buf.length,
        partPath: p,
        expectedSha256: sha(buf)
      })
    ).toBeNull()
  })

  it('flags a mismatch when the bytes are corrupt (right length, wrong content)', async () => {
    const expected = Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(4096, 7)])
    const corrupted = Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(4096, 9)])
    const p = write('bad.gguf', corrupted) // same length, different bytes
    const err = await verifyDownloadedPart({
      name: 'bad.gguf',
      writtenBytes: corrupted.length,
      responseTotalBytes: corrupted.length,
      partPath: p,
      expectedSha256: sha(expected)
    })
    expect(err).toMatch(/checksum mismatch/i)
    expect(fs.existsSync(p)).toBe(false)
  })

  it('is case-insensitive on the expected hex', async () => {
    const buf = Buffer.from('abc')
    const p = write('case.bin', buf)
    expect(
      await verifyDownloadedPart({
        name: 'case.bin',
        writtenBytes: buf.length,
        responseTotalBytes: buf.length,
        partPath: p,
        expectedSha256: sha(buf).toUpperCase()
      })
    ).toBeNull()
  })

  it('skips verification when no expected hash is known (opt-in)', async () => {
    const p = write('nohash.gguf', validGguf)
    expect(
      await verifyDownloadedPart({
        name: 'nohash.gguf',
        writtenBytes: validGguf.length,
        responseTotalBytes: validGguf.length,
        partPath: p
      })
    ).toBeNull()
  })
})
