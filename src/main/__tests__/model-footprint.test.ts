import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { filesMB } from '../model-footprint'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-footprint-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const file = (name: string, mb: number): string => {
  const at = path.join(dir, name)
  fs.writeFileSync(at, Buffer.alloc(mb * 1024 ** 2))
  return at
}

describe('filesMB', () => {
  it('adds the model files on disk, in MB', () => {
    expect(filesMB([file('weights.gguf', 3), file('mmproj.gguf', 1)])).toBe(4)
  })

  it('skips missing and empty paths', () => {
    expect(filesMB([file('only.gguf', 2), null, undefined, '', path.join(dir, 'gone.gguf')])).toBe(
      2
    )
  })
})
