import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { remainingDownloadBytes } from '../catalog-logic'
import { totalDownloadGb } from '../setup-logic'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

it('counts missing companions on disk, excludes installed packs, and reaches zero after install', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'og-download-total-'))
  roots.push(root)
  const files = [
    { name: 'wan.gguf', sizeBytes: 2.8e9 },
    { name: 'encoder.gguf', sizeBytes: 3.6e9 },
    { name: 'vae.safetensors', sizeBytes: 0.3e9 }
  ]
  const sizeOf = (name: string): number => {
    try {
      return fs.statSync(path.join(root, name)).size
    } catch {
      return 0
    }
  }
  fs.writeFileSync(path.join(root, 'wan.gguf'), 'installed weights fixture')
  fs.writeFileSync(path.join(root, 'vae.safetensors'), '')
  const bytes = remainingDownloadBytes({ files }, sizeOf)
  expect(bytes).toBe(3.9e9)
  expect(
    totalDownloadGb([
      { sizeGb: 6.7, downloadSizeGb: bytes / 1e9, installed: false },
      { sizeGb: 8, installed: true }
    ])
  ).toBe(3.9)
  for (const file of files) fs.writeFileSync(path.join(root, file.name), 'installed fixture')
  expect(remainingDownloadBytes({ files }, sizeOf)).toBe(0)
  fs.unlinkSync(path.join(root, 'encoder.gguf'))
  expect(remainingDownloadBytes({ files }, sizeOf)).toBe(3.6e9)
})
it('keeps unknown sizes at zero and preserves legacy plan totals', () => {
  expect(remainingDownloadBytes({ files: [{ name: 'unknown' }] }, () => 0)).toBe(0)
  expect(totalDownloadGb([{ sizeGb: 1.5, installed: false }])).toBe(1.5)
})
