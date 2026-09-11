import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  LocalModelRegistry,
  LocalModelRegistryError,
  type LocalModelRegistryFilePort
} from '../local-model-registry'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-local-registry-'))
  roots.push(value)
  return value
}

describe('local model registry filesystem adapter', () => {
  it('uses the canonical Shared kind policy for persisted model kinds', () => {
    const dir = root()
    const registry = new LocalModelRegistry(dir)
    const vision = {
      id: 'local:vision.gguf',
      name: 'Vision',
      primary: 'vision.gguf',
      kind: 'vision' as const,
      sizeBytes: 1024
    }
    registry.write([vision])
    expect(registry.read()).toEqual([vision])

    fs.writeFileSync(registry.file(), JSON.stringify([{ ...vision, kind: 'voice' }]))
    expect(() => registry.read()).toThrowError(
      expect.objectContaining<Partial<LocalModelRegistryError>>({
        code: 'LOCAL_MODEL_REGISTRY_CORRUPT'
      })
    )
  })

  it('distinguishes an absent registry from damaged JSON', () => {
    const dir = root()
    const registry = new LocalModelRegistry(dir)
    expect(registry.read()).toEqual([])

    fs.writeFileSync(registry.file(), '{broken')
    expect(() => registry.read()).toThrowError(
      expect.objectContaining<Partial<LocalModelRegistryError>>({
        code: 'LOCAL_MODEL_REGISTRY_CORRUPT'
      })
    )
  })

  it('atomically replaces a valid registry and preserves it when promotion fails', () => {
    const dir = root()
    const initial = [
      {
        id: 'local:first.gguf',
        name: 'First',
        primary: 'first.gguf',
        kind: 'text' as const,
        sizeBytes: 2048
      }
    ]
    const registry = new LocalModelRegistry(dir)
    registry.write(initial)
    expect(registry.read()).toEqual(initial)

    const failingFiles: LocalModelRegistryFilePort = {
      readFileSync: fs.readFileSync.bind(fs) as LocalModelRegistryFilePort['readFileSync'],
      mkdirSync: fs.mkdirSync.bind(fs) as LocalModelRegistryFilePort['mkdirSync'],
      writeFileSync: fs.writeFileSync.bind(fs) as LocalModelRegistryFilePort['writeFileSync'],
      renameSync: () => {
        throw Object.assign(new Error('disk is read only'), { code: 'EROFS' })
      },
      rmSync: fs.rmSync.bind(fs) as LocalModelRegistryFilePort['rmSync']
    }
    const failing = new LocalModelRegistry(dir, failingFiles)
    expect(() => failing.write([])).toThrowError(
      expect.objectContaining<Partial<LocalModelRegistryError>>({
        code: 'LOCAL_MODEL_REGISTRY_WRITE_FAILED'
      })
    )
    expect(registry.read()).toEqual(initial)
    expect(fs.readdirSync(dir)).toEqual(['local-models.json'])
  })
})
