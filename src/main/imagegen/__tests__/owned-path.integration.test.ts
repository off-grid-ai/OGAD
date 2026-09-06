import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  resolveExistingOwnedEntry,
  resolveExistingOwnedPath,
  resolveOwnedDestination
} from '../owned-path'

const tempDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('app-owned filesystem entries', () => {
  it('resolves real direct children and rejects traversal or absolute names', () => {
    const root = tempDir('offgrid-owned-root-')
    const model = path.join(root, 'image-model.gguf')
    fs.writeFileSync(model, 'model')

    expect(resolveExistingOwnedEntry(root, 'image-model.gguf')).toBe(fs.realpathSync.native(model))
    expect(resolveExistingOwnedEntry(root, '../image-model.gguf')).toBeNull()
    expect(resolveExistingOwnedEntry(root, '..\\image-model.gguf')).toBeNull()
    expect(resolveExistingOwnedEntry(root, model)).toBeNull()
  })

  it('rejects a direct child symlink that escapes the owned root', () => {
    const root = tempDir('offgrid-owned-root-')
    const outside = tempDir('offgrid-owned-outside-')
    const secret = path.join(outside, 'secret.gguf')
    fs.writeFileSync(secret, 'secret')
    fs.symlinkSync(secret, path.join(root, 'escaped.gguf'))

    expect(resolveExistingOwnedEntry(root, 'escaped.gguf')).toBeNull()
  })

  it('builds destinations only for direct children of the canonical root', () => {
    const realRoot = tempDir('offgrid-owned-root-')
    const parent = tempDir('offgrid-owned-parent-')
    const linkedRoot = path.join(parent, 'models')
    fs.symlinkSync(realRoot, linkedRoot)

    expect(resolveOwnedDestination(linkedRoot, 'adapter.safetensors')).toBe(
      path.join(fs.realpathSync.native(realRoot), 'adapter.safetensors')
    )
    expect(resolveOwnedDestination(linkedRoot, '../../adapter.safetensors')).toBeNull()
  })

  it('rejects an existing destination symlink that escapes the owned root', () => {
    const realRoot = tempDir('offgrid-owned-root-')
    const parent = tempDir('offgrid-owned-parent-')
    const linkedRoot = path.join(parent, 'models')
    fs.symlinkSync(realRoot, linkedRoot)
    const outside = path.join(tempDir('offgrid-owned-outside-'), 'adapter.safetensors')
    fs.writeFileSync(outside, 'outside')
    fs.symlinkSync(outside, path.join(realRoot, 'adapter.safetensors'))

    expect(resolveOwnedDestination(linkedRoot, 'adapter.safetensors')).toBeNull()
    expect(fs.realpathSync.native(linkedRoot)).toBe(fs.realpathSync.native(realRoot))
  })

  it('requires caller-supplied absolute paths to name that exact owned child', () => {
    const root = tempDir('offgrid-owned-root-')
    const owned = path.join(root, 'image.png')
    fs.writeFileSync(owned, 'png')

    expect(resolveExistingOwnedPath(root, owned)).toBe(fs.realpathSync.native(owned))
    expect(
      resolveExistingOwnedPath(root, path.join(tempDir('offgrid-other-'), 'image.png'))
    ).toBeNull()
    expect(resolveExistingOwnedPath(root, `${root}-evil/image.png`)).toBeNull()
  })

  it('accepts one owned child when the root and candidate use equivalent real paths', () => {
    const realRoot = tempDir('offgrid-owned-root-')
    const parent = tempDir('offgrid-owned-parent-')
    const linkedRoot = path.join(parent, 'generated-images')
    fs.symlinkSync(realRoot, linkedRoot)
    const owned = path.join(realRoot, 'image.png')
    fs.writeFileSync(owned, 'png')

    expect(resolveExistingOwnedPath(linkedRoot, owned)).toBe(fs.realpathSync.native(owned))
  })
})
