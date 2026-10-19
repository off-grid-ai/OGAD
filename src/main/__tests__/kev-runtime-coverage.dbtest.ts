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
  // The runtime reads the shards a base needs from its SafeTensors index, so the index is real
  // JSON (padded to its catalog size); every other file is a sparse stand-in of its catalog size.
  const shards = kev.files
    .map((file) => path.basename(file.name))
    .filter((name) => /^model\.safetensors-\d+-of-\d+\.safetensors$/.test(name))
  for (const file of kev.files) {
    if (file.name === 'kev-4b/base/model.safetensors.index.json') {
      const index = JSON.stringify({
        weight_map: Object.fromEntries(shards.map((shard, i) => [`layer.${i}.weight`, shard]))
      })
      fs.mkdirSync(base, { recursive: true })
      fs.writeFileSync(
        path.join(base, 'model.safetensors.index.json'),
        index.padEnd(file.sizeBytes ?? 0, ' ')
      )
    } else if (file.name.startsWith('kev-4b/base/')) {
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
