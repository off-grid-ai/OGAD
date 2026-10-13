import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configureRuntime } from '../runtime-env'
import {
  KEV_4B_ID,
  KEV_CHECKPOINT_PREFIX,
  desktopCatalog,
  listInstalled,
  resolveKevRuntimeArtifact
} from '../models-manager'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-kev-coverage-'))
const models = path.join(root, 'models')
const decisions = path.join(root, 'decision-models')
const checkpoint = path.join(models, KEV_CHECKPOINT_PREFIX)
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
    if (file.name.startsWith('kev-4b/base/')) {
      sparseFile(path.join(base, file.name.slice('kev-4b/base/'.length)), file.sizeBytes ?? 0)
    } else {
      sparseFile(path.join(models, file.name), file.sizeBytes ?? 0)
    }
  }
  sparseFile(path.join(source, '.venv', 'bin', 'python'), 1)
  sparseFile(path.join(bin, 'kev-local-server.py'), 1)
  fs.mkdirSync(models, { recursive: true })
})

afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

describe('Kev catalog and legacy runtime coverage', () => {
  it.runIf(
    (process.platform === 'darwin' && process.arch === 'arm64') ||
      process.platform === 'win32' ||
      (process.platform === 'linux' && process.arch === 'x64')
  )(
    'reuses the legacy base with the managed v1.0 checkpoint and resolves its supported runtime',
    async () => {
      expect(await listInstalled()).toContain(KEV_4B_ID)
      expect(resolveKevRuntimeArtifact()).toMatchObject({ checkpoint, base })
    }
  )
})
