/**
 * Tests for the shared GGUF integrity check. isValidGgufHeader is pure (size +
 * magic bytes); isValidGgufFile is exercised against REAL files in a temp dir
 * (no fs mock) so the read path is proven, not simulated.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { GGUF_MIN_BYTES, verifyArtifactFacts } from '@offgrid/models'
import { verifyArtifactFile } from '../gguf'

describe('isValidGgufHeader — pure size + magic judgement', () => {
  it('accepts a big-enough file whose first four bytes are the GGUF magic', () => {
    expect(verifyArtifactFacts({ request: { path: 'x', name: 'x.gguf', origin: 'runtime' }, stat: { exists: true, isFile: true, sizeBytes: GGUF_MIN_BYTES }, prefix: Buffer.from('GGUF') }).valid).toBe(true)
    expect(verifyArtifactFacts({ request: { path: 'x', name: 'x.gguf', origin: 'runtime' }, stat: { exists: true, isFile: true, sizeBytes: 10_000_000 }, prefix: Buffer.from('GGUF') }).valid).toBe(true)
  })

  it('rejects a file under the minimum size even with the right magic', () => {
    expect(verifyArtifactFacts({ request: { path: 'x', name: 'x.gguf', origin: 'runtime' }, stat: { exists: true, isFile: true, sizeBytes: GGUF_MIN_BYTES - 1 }, prefix: Buffer.from('GGUF') }).valid).toBe(false)
    expect(verifyArtifactFacts({ request: { path: 'x', name: 'x.gguf', origin: 'runtime' }, stat: { exists: true, isFile: true, sizeBytes: 0 }, prefix: Buffer.from('GGUF') }).valid).toBe(false)
  })

  it('rejects a big-enough file with the wrong magic', () => {
    expect(verifyArtifactFacts({ request: { path: 'x', name: 'x.gguf', origin: 'runtime' }, stat: { exists: true, isFile: true, sizeBytes: 10_000_000 }, prefix: Buffer.from('ELF\0') }).valid).toBe(false)
    expect(verifyArtifactFacts({ request: { path: 'x', name: 'x.gguf', origin: 'runtime' }, stat: { exists: true, isFile: true, sizeBytes: 10_000_000 }, prefix: Buffer.alloc(4) }).valid).toBe(false)
  })
})

describe('isValidGgufFile — real files in a temp dir', () => {
  let dir: string
  const write = (name: string, contents: Buffer): string => {
    const p = path.join(dir, name)
    fs.writeFileSync(p, contents)
    return p
  }

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gguf-test-'))
  })
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('accepts a real file with the GGUF magic and enough padding', async () => {
    const buf = Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(GGUF_MIN_BYTES)])
    expect((await verifyArtifactFile(write('good.gguf', buf), fs, 'runtime')).valid).toBe(true)
  })

  it('rejects a truncated file (right magic but under the size floor)', async () => {
    expect((await verifyArtifactFile(write('tiny.gguf', Buffer.from('GGUF', 'ascii')), fs, 'runtime')).valid).toBe(false)
  })

  it('rejects a big file with the wrong magic (corrupt/other format)', async () => {
    const buf = Buffer.concat([Buffer.from('%PDF', 'ascii'), Buffer.alloc(GGUF_MIN_BYTES)])
    expect((await verifyArtifactFile(write('wrong.gguf', buf), fs, 'runtime')).valid).toBe(false)
  })

  it('returns false (never throws) for a nonexistent file', async () => {
    expect((await verifyArtifactFile(path.join(dir, 'nope.gguf'), fs, 'runtime')).valid).toBe(false)
  })
})
