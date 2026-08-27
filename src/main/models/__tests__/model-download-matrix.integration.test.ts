// Release journeys #17-#19, #21, and #23 through the production desktop model manager.
// Only boundaries outside Off Grid AI are controlled: HTTP serves small deterministic
// model bytes, while tiny executable fixtures stand in for the native image, STT,
// and TTS runtimes. Download sequencing, integrity checks, filesystem promotion,
// installed/readiness decisions, activation, and runtime selection all stay real.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const originalDataDir = process.env.OFFGRID_DATA_DIR
const originalBinDir = process.env.OFFGRID_BIN_DIR
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-model-download-matrix-'))
const dataDir = path.join(testRoot, 'data')
const binDir = path.join(testRoot, 'bin')
process.env.OFFGRID_DATA_DIR = dataDir
process.env.OFFGRID_BIN_DIR = binDir

vi.mock('electron', () => ({
  app: {
    getPath: () => dataDir,
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getVersion: () => 'test'
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

const manager = await import('../../models-manager')
const { CATALOG } = await import('@offgrid/models')

type CatalogModel = (typeof CATALOG)[number]
type ModelFile = CatalogModel['files'][number]
type ModelDownloadProgress = import('../../models-manager').DownloadProgress

const byKind = (kind: CatalogModel['kind'], fileCount?: number): CatalogModel => {
  const entry = CATALOG.find(
    (candidate) =>
      candidate.kind === kind && (fileCount === undefined || candidate.files.length === fileCount)
  )
  if (!entry) throw new Error(`Model catalog needs an installable ${kind} fixture`)
  return entry
}

// The catalog no longer has a pure single-file 'text' kind — every former text
// model ships an mmproj so it's classified 'vision', and the vision model IS the
// chat model (activates into the `.text` chat slot). Single-file download
// mechanics are exercised with any single-file model (image/voice exist).
const singleFileModels = CATALOG.filter((m) => m.files.length === 1)
const chatModel = byKind('vision', 2)
const visionModel = byKind('vision', 2)
const imageModel = byKind('image', 3)
const speechModel = CATALOG.find(
  (candidate) => candidate.kind === 'transcription' && candidate.engine === 'parakeet'
)
if (!speechModel) throw new Error('Model catalog needs an installable Parakeet fixture')

const installedByTest = new Set<string>()

function executable(file: string, source: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, source, { mode: 0o755 })
}

function modelBytes(file: ModelFile, seed: number): Buffer {
  if (file.name.endsWith('.gguf')) {
    return Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2_044, seed)])
  }
  return Buffer.from(`off-grid-${file.name}-${seed}`)
}

interface PendingResponse {
  url: string
  resolve: (response: Response) => void
}

function controlledHttp(): PendingResponse[] {
  const pending: PendingResponse[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (input: string | URL | Request) =>
        new Promise<Response>((resolve) => {
          pending.push({ url: String(input), resolve })
        })
    )
  )
  return pending
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the download boundary')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function downloadEveryRequiredFile(entry: CatalogModel): Promise<{
  progress: ModelDownloadProgress[]
  bytes: Map<string, Buffer>
}> {
  const pending = controlledHttp()
  const progress: ModelDownloadProgress[] = []
  const bytes = new Map<string, Buffer>()
  const result = manager.downloadModel(entry.id, (event) => progress.push(event))

  for (const [index, file] of entry.files.entries()) {
    await waitFor(() => pending.length === index + 1)
    expect(pending[index]!.url).toBe(file.url)

    // A model is never ready while its current or any later required file is pending.
    expect(await manager.listInstalled()).not.toContain(entry.id)
    expect((await manager.getStorageInfo()).models.map((model) => model.id)).not.toContain(entry.id)

    const body = modelBytes(file, index + 1)
    bytes.set(file.name, body)
    pending[index]!.resolve(
      new Response(new Uint8Array(body), {
        status: 200,
        headers: { 'content-length': String(body.length) }
      })
    )

    if (index < entry.files.length - 1) {
      await waitFor(() => pending.length === index + 2)
      expect(fs.readFileSync(path.join(dataDir, 'models', file.name))).toEqual(body)
      expect(await manager.listInstalled()).not.toContain(entry.id)
    }
  }

  await expect(result).resolves.toEqual({ success: true })
  installedByTest.add(entry.id)

  expect(await manager.listInstalled()).toContain(entry.id)
  expect(manager.downloadStatus(entry.id)).toMatchObject({
    modelId: entry.id,
    status: 'completed',
    percent: 100
  })
  expect(progress[0]).toMatchObject({ modelId: entry.id, status: 'downloading', percent: 0 })
  expect(progress.at(-1)).toMatchObject({ modelId: entry.id, status: 'completed', percent: 100 })
  for (const file of entry.files) {
    expect(fs.readFileSync(path.join(dataDir, 'models', file.name))).toEqual(bytes.get(file.name))
    expect(fs.existsSync(path.join(dataDir, 'models', `${file.name}.part`))).toBe(false)
  }

  return { progress, bytes }
}

beforeAll(() => {
  fs.mkdirSync(path.join(dataDir, 'models'), { recursive: true })

  // Native process boundaries only. The real transcription service resolves this
  // executable and passes the downloaded Parakeet paths to it.
  executable(
    path.join(binDir, 'parakeet', 'bin', 'sherpa-onnx-offline'),
    '#!/bin/sh\nprintf \'%s\\n\' \'{"text":"downloaded model dictation works"}\'\n'
  )
  executable(path.join(binDir, 'sd', 'sd-cli'), '#!/bin/sh\nexit 0\n')
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const id of installedByTest) {
    await manager.deleteModel(id)
    await manager.clearDownload(id)
  }
  installedByTest.clear()
  fs.rmSync(path.join(dataDir, 'models', 'active-model.json'), { force: true })
  fs.rmSync(path.join(dataDir, 'models', 'active-modalities.json'), { force: true })
})

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  if (originalBinDir === undefined) delete process.env.OFFGRID_BIN_DIR
  else process.env.OFFGRID_BIN_DIR = originalBinDir
  fs.rmSync(testRoot, { recursive: true, force: true })
})

describe('model download release matrix', () => {
  it('downloads the chat (vision) model with observable progress and makes it activatable (#17)', async () => {
    const { progress } = await downloadEveryRequiredFile(chatModel)

    expect(
      progress.some((event) => event.status === 'downloading' && (event.percent ?? 0) > 0)
    ).toBe(true)
    // A chat/vision model activates into the `.text` (chat LLM) slot via setActiveModel.
    expect(await manager.activateModel(chatModel.id)).toEqual({ success: true })
    expect(manager.getActiveModalities().text).toBe(chatModel.id)
    expect(await manager.getActiveModelIds()).toContain(chatModel.id)
  })

  it('does not make a vision model ready until weights and projector complete (#18)', async () => {
    await downloadEveryRequiredFile(visionModel)

    expect(await manager.activateModel(visionModel.id)).toEqual({ success: true })
    const active = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'models', 'active-model.json'), 'utf8')
    ) as { id: string; primary: string; mmproj: string }
    expect(active).toEqual({
      id: visionModel.id,
      primary: visionModel.files.find((file) => file.role === 'primary')!.name,
      mmproj: visionModel.files.find((file) => file.role === 'mmproj')!.name
    })
  })

  it('makes a complete Parakeet download selectable by the real dictation service (#19)', async () => {
    const { getActiveTranscription } = await import('../../transcription/select')
    expect(getActiveTranscription().isAvailable()).toBe(false)

    await downloadEveryRequiredFile(speechModel)
    expect(await manager.activateModel(speechModel.id)).toEqual({ success: true })
    const dictation = getActiveTranscription()

    expect(dictation.isAvailable()).toBe(true)
    await expect(
      dictation.transcribe({ path: path.join(testRoot, 'synthetic.wav') }, { alreadyWav16k: true })
    ).resolves.toEqual({ text: 'downloaded model dictation works', language: 'en' })
  })

  it('keeps a multi-file image model unavailable until the whole runtime stack lands (#21)', async () => {
    const { imageGenStatus } = await import('../../imagegen')
    expect(imageGenStatus()).toMatchObject({ available: false, models: [] })

    await downloadEveryRequiredFile(imageModel)
    expect(await manager.activateModel(imageModel.id)).toEqual({ success: true })

    const status = imageGenStatus()
    expect(status.available).toBe(true)
    expect(status.models).toContain(imageModel.files.find((file) => file.role === 'primary')!.name)
    expect(status.active).toBe(imageModel.files.find((file) => file.role === 'primary')!.name)
  })

  it('keeps concurrent downloads ordered and isolated when the second completes first', async () => {
    const concurrentModels = singleFileModels.slice(0, 2)
    const [firstModel, secondModel] = concurrentModels
    if (!firstModel || !secondModel) {
      throw new Error('Model catalog needs two single-file text fixtures')
    }

    const firstFile = firstModel.files[0]!
    const secondFile = secondModel.files[0]!
    const firstBytes = modelBytes(firstFile, 31)
    const secondBytes = modelBytes(secondFile, 47)

    const pending = controlledHttp()
    const firstProgress: ModelDownloadProgress[] = []
    const secondProgress: ModelDownloadProgress[] = []

    const firstDownload = manager.downloadModel(firstModel.id, (event) => firstProgress.push(event))
    await waitFor(() => pending.length === 1)
    const secondDownload = manager.downloadModel(secondModel.id, (event) =>
      secondProgress.push(event)
    )
    await waitFor(() => pending.length === 2)

    const initialOrder = manager.listDownloads().map((download) => download.modelId)
    const firstWhileBothRun = manager.downloadStatus(firstModel.id)
    const secondWhileBothRun = manager.downloadStatus(secondModel.id)
    let secondResult: Awaited<typeof secondDownload> | undefined
    let firstResult: Awaited<typeof firstDownload> | undefined
    let installedAfterSecond: string[] = []
    let firstWhileSecondDone: ModelDownloadProgress | null = null
    try {
      pending[1]!.resolve(
        new Response(new Uint8Array(secondBytes), {
          status: 200,
          headers: { 'content-length': String(secondBytes.length) }
        })
      )
      secondResult = await secondDownload
      installedByTest.add(secondModel.id)
      installedAfterSecond = await manager.listInstalled()
      firstWhileSecondDone = manager.downloadStatus(firstModel.id)

      pending[0]!.resolve(
        new Response(new Uint8Array(firstBytes), {
          status: 200,
          headers: { 'content-length': String(firstBytes.length) }
        })
      )
      firstResult = await firstDownload
      installedByTest.add(firstModel.id)
    } finally {
      // Release both remote-boundary promises even if a future regression fails above.
      pending[0]?.resolve(
        new Response(new Uint8Array(firstBytes), {
          status: 200,
          headers: { 'content-length': String(firstBytes.length) }
        })
      )
      pending[1]?.resolve(
        new Response(new Uint8Array(secondBytes), {
          status: 200,
          headers: { 'content-length': String(secondBytes.length) }
        })
      )
      await Promise.allSettled([firstDownload, secondDownload])
    }

    expect(initialOrder).toEqual([firstModel.id, secondModel.id])
    expect(firstWhileBothRun).toMatchObject({
      modelId: firstModel.id,
      status: 'downloading',
      percent: 0
    })
    expect(secondWhileBothRun).toMatchObject({
      modelId: secondModel.id,
      status: 'downloading',
      percent: 0
    })
    expect(secondResult).toEqual({ success: true })
    expect(firstWhileSecondDone).toMatchObject({
      modelId: firstModel.id,
      status: 'downloading',
      percent: 0
    })
    expect(installedAfterSecond).toEqual([secondModel.id])
    expect(firstResult).toEqual({ success: true })

    expect(manager.listDownloads()).toEqual([
      expect.objectContaining({
        modelId: firstModel.id,
        status: 'completed',
        percent: 100
      }),
      expect.objectContaining({
        modelId: secondModel.id,
        status: 'completed',
        percent: 100
      })
    ])
    expect(firstProgress.every((event) => event.modelId === firstModel.id)).toBe(true)
    expect(secondProgress.every((event) => event.modelId === secondModel.id)).toBe(true)
    expect(firstProgress).toContainEqual(
      expect.objectContaining({ currentFile: firstFile.name, status: 'downloading' })
    )
    expect(secondProgress).toContainEqual(
      expect.objectContaining({ currentFile: secondFile.name, status: 'downloading' })
    )
    expect(firstProgress.at(-1)).toMatchObject({ status: 'completed', percent: 100 })
    expect(secondProgress.at(-1)).toMatchObject({ status: 'completed', percent: 100 })
    expect((await manager.listInstalled()).sort()).toEqual([firstModel.id, secondModel.id].sort())
    expect(fs.readFileSync(path.join(dataDir, 'models', firstFile.name))).toEqual(firstBytes)
    expect(fs.readFileSync(path.join(dataDir, 'models', secondFile.name))).toEqual(secondBytes)
    expect(fs.existsSync(path.join(dataDir, 'models', `${firstFile.name}.part`))).toBe(false)
    expect(fs.existsSync(path.join(dataDir, 'models', `${secondFile.name}.part`))).toBe(false)
  })

  it('caps three active downloads, exposes the FIFO queue, and drains every item (#22)', async () => {
    const queueModels = singleFileModels.filter((m) => m.runtime !== 'mflux').slice(0, 4)
    if (queueModels.length < 4) {
      throw new Error('Model catalog needs four single-file fixtures')
    }

    const pending = controlledHttp()
    const progress = new Map<string, ModelDownloadProgress[]>()
    const downloads = queueModels.map((model) => {
      const events: ModelDownloadProgress[] = []
      progress.set(model.id, events)
      return manager.downloadModel(model.id, (event) => events.push(event))
    })

    await waitFor(() => pending.length === 3)
    const initial = manager
      .listDownloads()
      .filter((download) => queueModels.some((model) => model.id === download.modelId))
    expect(initial.filter((download) => download.status === 'downloading')).toHaveLength(3)
    expect(initial.filter((download) => download.status === 'queued')).toEqual([
      expect.objectContaining({ modelId: queueModels[3]!.id, percent: 0 })
    ])
    await expect(manager.downloadModel(queueModels[3]!.id)).resolves.toEqual({
      success: false,
      error: 'already downloading'
    })
    expect(pending).toHaveLength(3)

    try {
      const firstFile = queueModels[0]!.files[0]!
      const firstBytes = modelBytes(firstFile, 61)
      pending[0]!.resolve(
        new Response(new Uint8Array(firstBytes), {
          status: 200,
          headers: { 'content-length': String(firstBytes.length) }
        })
      )
      await expect(downloads[0]).resolves.toEqual({ success: true })
      installedByTest.add(queueModels[0]!.id)
      await waitFor(() => pending.length === 4)

      expect(manager.downloadStatus(queueModels[3]!.id)).toMatchObject({
        status: 'downloading',
        percent: 0
      })
      expect(progress.get(queueModels[3]!.id)).toEqual([
        expect.objectContaining({ status: 'queued' }),
        expect.objectContaining({ status: 'downloading' })
      ])

      for (let index = 1; index < queueModels.length; index++) {
        const file = queueModels[index]!.files[0]!
        const bytes = modelBytes(file, 61 + index)
        pending[index]!.resolve(
          new Response(new Uint8Array(bytes), {
            status: 200,
            headers: { 'content-length': String(bytes.length) }
          })
        )
      }
      const results = await Promise.all(downloads)
      for (const model of queueModels) installedByTest.add(model.id)

      expect(results).toEqual(queueModels.map(() => ({ success: true })))
      const terminal = manager
        .listDownloads()
        .filter((download) => queueModels.some((model) => model.id === download.modelId))
      expect(terminal).toHaveLength(4)
      expect(terminal.every((download) => download.status === 'completed')).toBe(true)
    } finally {
      for (const [index, response] of pending.entries()) {
        const file = queueModels[index]?.files[0]
        if (!file) continue
        const bytes = modelBytes(file, 80 + index)
        response.resolve(
          new Response(new Uint8Array(bytes), {
            status: 200,
            headers: { 'content-length': String(bytes.length) }
          })
        )
      }
      await Promise.allSettled(downloads)
    }
  })

  it('deletes only the selected installed model while another download continues (#23)', async () => {
    const existing = singleFileModels[0]
    const downloading = singleFileModels.find((m) => m.id !== existing?.id)
    if (!existing || !downloading) {
      throw new Error('Model catalog needs two single-file fixtures')
    }

    await downloadEveryRequiredFile(existing)

    const pending = controlledHttp()
    const inFlight = manager.downloadModel(downloading.id)
    await waitFor(() => pending.length === 1)
    expect(manager.downloadStatus(downloading.id)).toMatchObject({ status: 'downloading' })

    await expect(manager.deleteModel(existing.id)).resolves.toEqual({
      success: true,
      freedFiles: 1
    })
    installedByTest.delete(existing.id)
    expect(await manager.listInstalled()).not.toContain(existing.id)
    expect(manager.downloadStatus(downloading.id)).toMatchObject({ status: 'downloading' })

    const file = downloading.files[0]!
    const body = modelBytes(file, 9)
    pending[0]!.resolve(
      new Response(new Uint8Array(body), {
        status: 200,
        headers: { 'content-length': String(body.length) }
      })
    )

    await expect(inFlight).resolves.toEqual({ success: true })
    installedByTest.add(downloading.id)
    expect(fs.readFileSync(path.join(dataDir, 'models', file.name))).toEqual(body)
    expect(await manager.listInstalled()).toContain(downloading.id)
    expect(manager.downloadStatus(downloading.id)).toMatchObject({ status: 'completed' })
  })
})
