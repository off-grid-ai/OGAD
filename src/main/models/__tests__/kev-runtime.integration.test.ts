import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureRuntime } from '../../runtime-env'
import {
  KEV_4B_ID,
  KEV_CHECKPOINT_PREFIX,
  desktopCatalog,
  downloadModel,
  listInstalled,
  resolveKevRuntimeArtifact
} from '../../models-manager'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-kev-runtime-'))
const models = path.join(root, 'models')
const decisions = path.join(root, 'decision-models')
const checkpoint = path.join(models, KEV_CHECKPOINT_PREFIX)
const base = path.join(decisions, 'qwen3.5-4b-base')
const source = path.join(decisions, 'kev-source')
const bin = path.join(root, 'bin')
const LEGACY_CHECKPOINT_SIZES = {
  'head.pt': 5_248_767,
  'adapter_config.json': 1_271,
  'adapter_model.safetensors': 129_924_032
}

function sparseFile(filePath: string, size: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const descriptor = fs.openSync(filePath, 'w')
  fs.ftruncateSync(descriptor, size)
  fs.closeSync(descriptor)
}

beforeEach(async () => {
  fs.rmSync(models, { recursive: true, force: true })
  fs.rmSync(decisions, { recursive: true, force: true })
  configureRuntime({ dataDir: root, binRoots: [bin] })
  const kev = (await desktopCatalog()).find((model) => model.id === KEV_4B_ID)
  if (!kev) throw new Error('Kev catalog entry is missing')
  for (const file of kev.files) {
    if (file.name.startsWith('kev-4b/base/')) {
      sparseFile(path.join(base, file.name.slice('kev-4b/base/'.length)), file.sizeBytes ?? 0)
    }
  }
  for (const [name, size] of Object.entries(LEGACY_CHECKPOINT_SIZES)) {
    sparseFile(path.join(decisions, 'kev-4b-qwen3.5', name), size)
    sparseFile(path.join(models, 'kev-4b', 'checkpoint', name), size)
  }
  sparseFile(path.join(source, '.venv', 'bin', 'python'), 1)
  sparseFile(path.join(bin, 'kev-local-server.py'), 1)
  fs.mkdirSync(models, { recursive: true })
})

afterEach(() => vi.unstubAllGlobals())

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const supportedRuntime =
  (process.platform === 'darwin' && process.arch === 'arm64') ||
  process.platform === 'win32' ||
  (process.platform === 'linux' && process.arch === 'x64')

async function installCheckpoint(modelsDirectory = models): Promise<void> {
  const kev = (await desktopCatalog()).find((model) => model.id === KEV_4B_ID)!
  for (const file of kev.files.filter((file) => file.name.startsWith(KEV_CHECKPOINT_PREFIX))) {
    sparseFile(path.join(modelsDirectory, file.name), file.sizeBytes ?? 0)
  }
}

describe('Kev v1.0 catalog and runtime', () => {
  it('requires the v1.0 checkpoint even when both legacy checkpoints and the base exist', async () => {
    expect(await listInstalled()).not.toContain(KEV_4B_ID)
    expect(resolveKevRuntimeArtifact()).toBeNull()
  })

  it.each([
    ['pre-catalog', path.join(decisions, 'kev-4b-qwen3.5')],
    ['old managed', path.join(models, 'kev-4b', 'checkpoint')]
  ])('rejects the %s checkpoint with a complete base', async (_label, dirToKeep) => {
    const other =
      dirToKeep === path.join(decisions, 'kev-4b-qwen3.5')
        ? path.join(models, 'kev-4b', 'checkpoint')
        : path.join(decisions, 'kev-4b-qwen3.5')
    fs.rmSync(other, { recursive: true })
    expect(await listInstalled()).not.toContain(KEV_4B_ID)
    expect(resolveKevRuntimeArtifact()).toBeNull()
  })

  it('counts the managed v1.0 checkpoint with the legacy base as installed', async () => {
    await installCheckpoint()
    expect(await listInstalled()).toContain(KEV_4B_ID)
  })

  it('counts the managed v1.0 checkpoint with the legacy base as installed after moving models', async () => {
    const movedModels = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-kev-moved-models-'))
    try {
      configureRuntime({ dataDir: root, modelsDir: movedModels, binRoots: [bin] })
      await installCheckpoint(movedModels)
      expect(await listInstalled()).toContain(KEV_4B_ID)
    } finally {
      configureRuntime({ dataDir: root, modelsDir: undefined, binRoots: [bin] })
      fs.rmSync(movedModels, { recursive: true, force: true })
    }
  })

  it.runIf(supportedRuntime)('resolves the managed v1.0 checkpoint and legacy base', async () => {
    await installCheckpoint()
    expect(resolveKevRuntimeArtifact()).toMatchObject({ checkpoint, base })
  })

  it('pins every checkpoint file to the v1.0 revision and a SHA-256 digest', async () => {
    const kev = (await desktopCatalog()).find((model) => model.id === KEV_4B_ID)!
    const files = kev.files.filter((file) => !file.name.startsWith('kev-4b/base/'))
    expect(KEV_CHECKPOINT_PREFIX).toBe('kev-4b/checkpoint-v1.0/')
    expect(files).toHaveLength(3)
    for (const file of files) {
      expect(file.name.startsWith(KEV_CHECKPOINT_PREFIX)).toBe(true)
      expect(file.url).toBe(
        `https://huggingface.co/jaredpalmer/kev-4b/resolve/591dcb5bd6d05eb0b5131ea6608f93f10243335c/${path.basename(file.name)}`
      )
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/i)
    }
  })

  it('keeps the old checkpoint when the v1.0 download fails integrity checks', async () => {
    const requests: string[] = []
    // The existing download harness controls only the external HTTP boundary.
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      requests.push(String(input))
      return new Response(new Uint8Array([1]), {
        status: 200,
        headers: { 'content-length': '1' }
      })
    })
    expect((await downloadModel(KEV_4B_ID)).success).toBe(false)
    const kev = (await desktopCatalog()).find((model) => model.id === KEV_4B_ID)!
    expect(requests).toEqual([kev.files[0]!.url])
    expect(fs.existsSync(path.join(models, 'kev-4b', 'checkpoint', 'head.pt'))).toBe(true)
    expect(fs.existsSync(path.join(decisions, 'kev-4b-qwen3.5', 'head.pt'))).toBe(true)
    expect(await listInstalled()).not.toContain(KEV_4B_ID)
  })

  it('keeps both legacy checkpoints, the new checkpoint and the base after a Kev download', async () => {
    await installCheckpoint()
    const legacyCheckpoint = path.join(decisions, 'kev-4b-qwen3.5')
    const baseFiles = fs.readdirSync(base)
    const progress: string[] = []
    // Existing files use the real download skip path; no synthetic bytes can satisfy
    // the immutable release hashes. The queue must still publish completion and keep the older checkpoint.
    expect(await downloadModel(KEV_4B_ID, (event) => progress.push(event.status ?? ''))).toEqual({
      success: true
    })
    expect(progress).toContain('completed')
    expect(fs.readdirSync(path.join(models, 'kev-4b', 'checkpoint'))).toEqual(
      Object.keys(LEGACY_CHECKPOINT_SIZES).sort()
    )
    expect(fs.readdirSync(legacyCheckpoint)).toEqual(Object.keys(LEGACY_CHECKPOINT_SIZES).sort())
    expect(fs.readdirSync(base)).toEqual(baseFiles)
    expect(await listInstalled()).toContain(KEV_4B_ID)
    for (const [name, size] of Object.entries(LEGACY_CHECKPOINT_SIZES)) {
      expect(fs.statSync(path.join(legacyCheckpoint, name)).size).toBe(size)
      expect(fs.statSync(path.join(models, 'kev-4b', 'checkpoint', name)).size).toBe(size)
    }
    const kev = (await desktopCatalog()).find((model) => model.id === KEV_4B_ID)!
    for (const file of kev.files.filter((file) => file.name.startsWith(KEV_CHECKPOINT_PREFIX))) {
      expect(fs.statSync(path.join(models, file.name)).size).toBe(file.sizeBytes)
    }
    for (const file of kev.files.filter((file) => file.name.startsWith('kev-4b/base/'))) {
      expect(fs.statSync(path.join(base, path.basename(file.name))).size).toBe(file.sizeBytes)
    }
  })
})
