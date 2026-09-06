// Branch fill for the downloaded-models registry against a real temp dir. Covers the
// paths downloaded-models.test.ts leaves out: a registry file whose JSON is a non-array
// (reported explicitly), a model with an empty files list (never counts as installed), and a
// zero-byte file on disk (present but empty -> not installed). No mocks; real fs.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  readDownloaded,
  installedDownloadedIds,
  recordDownloaded,
  findDownloaded,
  downloadedProtectedNames
} from '../downloaded-models'

let dir: string
const REG = 'downloaded-models.json'

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-dl-branch-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('downloaded-models branch cases', () => {
  it('reports a registry whose parsed JSON is an object instead of an array', () => {
    fs.writeFileSync(path.join(dir, REG), JSON.stringify({ not: 'an array' }))
    expect(() => readDownloaded(dir)).toThrow('Downloaded-model registry must contain an array.')
  })

  it('reports a registry whose parsed JSON is a bare number instead of an array', () => {
    fs.writeFileSync(path.join(dir, REG), '42')
    expect(() => readDownloaded(dir)).toThrow('Downloaded-model registry must contain an array.')
  })

  it('a model with an empty files list is never reported installed', () => {
    recordDownloaded(dir, { id: 'empty/model', name: 'Empty', kind: 'text', files: [] })
    expect(installedDownloadedIds(dir)).toEqual([])
    // ...but it is still recorded and findable.
    expect(findDownloaded(dir, 'empty/model')?.name).toBe('Empty')
  })

  it('a zero-byte file on disk counts as absent (size > 0 gate fails)', () => {
    fs.writeFileSync(path.join(dir, 'weights.gguf'), Buffer.alloc(0)) // empty file
    recordDownloaded(dir, { id: 'zero/model', name: 'Zero', kind: 'text', files: ['weights.gguf'] })
    expect(installedDownloadedIds(dir)).toEqual([])
  })

  it('protected-names set is empty for a fresh (missing) registry', () => {
    expect(downloadedProtectedNames(dir).size).toBe(0)
  })

  it('protected-names collects every file across multiple registered models', () => {
    recordDownloaded(dir, { id: 'a', name: 'A', kind: 'text', files: ['a1.gguf', 'a2.gguf'] })
    recordDownloaded(dir, { id: 'b', name: 'B', kind: 'vision', files: ['b1.gguf'] })
    expect(downloadedProtectedNames(dir)).toEqual(new Set(['a1.gguf', 'a2.gguf', 'b1.gguf']))
  })
})
