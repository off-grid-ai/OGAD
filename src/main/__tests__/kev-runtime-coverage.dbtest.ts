import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { configureRuntime } from '../runtime-env'
import {
  KEV_4B_ID,
  desktopCatalog,
  listInstalled,
  resolveKevRuntimeArtifact
} from '../models-manager'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-kev-coverage-'))
const models = path.join(root, 'models')
const decisions = path.join(root, 'decision-models')
const checkpoint = path.join(decisions, 'kev-4b-qwen3.5')
const base = path.join(decisions, 'qwen3.5-4b-base')
const source = path.join(decisions, 'kev-source')
const bin = path.join(root, 'bin')

function sparseFile(filePath: string, size: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const descriptor = fs.openSync(filePath, 'w')
  fs.ftruncateSync(descriptor, size)
  fs.closeSync(descriptor)
}

beforeAll(async () => {
  configureRuntime({ dataDir: root, binRoots: [bin] })
  const kev = (await desktopCatalog()).find((model) => model.id === KEV_4B_ID)
  if (!kev) throw new Error('Kev catalog entry is missing')
  for (const file of kev.files) {
    const relative = file.name.replace(/^kev-4b\/(checkpoint|base)\//, '')
    const directory = file.name.includes('/checkpoint/') ? checkpoint : base
    sparseFile(path.join(directory, relative), file.sizeBytes ?? 0)
  }
  sparseFile(path.join(source, '.venv', 'bin', 'python'), 1)
  sparseFile(path.join(bin, 'kev-local-server.py'), 1)
  fs.mkdirSync(models, { recursive: true })
})

afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

describe('Kev catalog and legacy runtime coverage', () => {
  it('reuses the complete pre-catalog model and resolves its supported runtime', async () => {
    expect(await listInstalled()).toContain(KEV_4B_ID)
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const arch = vi.spyOn(process, 'arch', 'get').mockReturnValue('arm64')
    try {
      expect(resolveKevRuntimeArtifact()).toMatchObject({ checkpoint, base })
    } finally {
      platform.mockRestore()
      arch.mockRestore()
    }
  })
})
