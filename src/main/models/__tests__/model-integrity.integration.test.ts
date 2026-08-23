// Exercises the real model-manager ingress paths against a temporary models
// directory. Network delivery is the only boundary fake; validation, streaming,
// filesystem promotion, registry state, and installed-model discovery stay real.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Writable } from 'stream'
import { NETWORK_UNAVAILABLE_MESSAGE } from '../download-error'

const originalDataDir = process.env.OFFGRID_DATA_DIR
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-model-integrity-'))
process.env.OFFGRID_DATA_DIR = dataDir

const manager = await import('../../models-manager')
const { CATALOG } = await import('@offgrid/models')

// Single-file GGUF models — download-mechanics fixtures (disk-full / interrupted /
// offline). Kind-agnostic: the catalog no longer has a pure 'text' kind (every
// former text model ships an mmproj → derived 'vision'), and these scenarios test
// the download loop, not the model's modality. Single-file GGUFs exist as image /
// voice / transcription entries.
const fixtures = CATALOG.flatMap((entry) => {
  const file = entry.files.at(0)
  if (entry.files.length !== 1 || !file?.name.endsWith('.gguf')) return []
  return [{ entry, fileName: file.name, filePath: path.join(dataDir, 'models', file.name) }]
})

// 'text' dropped: the chat model is a vision model now (mmproj), so there's no
// standalone text kind to select.
const activeSelectionFixtures = ['vision', 'image', 'voice', 'transcription'].map(
  (kind) => {
    const entry = CATALOG.find((candidate) => candidate.kind === kind && candidate.files.length > 0)
    if (!entry) throw new Error(`Model catalog needs an installable ${kind} fixture`)
    return { kind, entry }
  }
)

const [primary, diskFailure, interrupted, offline] = fixtures
if (!primary || !diskFailure || !interrupted || !offline) {
  throw new Error('Model catalog needs four single-file GGUF fixtures')
}

interface CapacityProbe {
  acceptedBytes: number
  partialExistedAtFailure: boolean
}

function capacityLimitedFileStream(
  filePath: string,
  capacity: number,
  probe: CapacityProbe
): fs.WriteStream {
  let remaining = capacity
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const accepted = chunk.subarray(0, remaining)
      if (accepted.length > 0) fs.appendFileSync(filePath, accepted)
      probe.acceptedBytes += accepted.length
      remaining -= accepted.length
      if (accepted.length === chunk.length) {
        callback()
        return
      }
      probe.partialExistedAtFailure = fs.statSync(filePath).size === probe.acceptedBytes
      callback(
        Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
      )
    }
  }) as unknown as fs.WriteStream
}

beforeAll(() => {
  fs.mkdirSync(path.dirname(primary.filePath), { recursive: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const fixture of fixtures) {
    fs.rmSync(fixture.filePath, { force: true })
    fs.rmSync(`${fixture.filePath}.part`, { force: true })
  }
  for (const { entry } of activeSelectionFixtures) {
    for (const file of entry.files) {
      fs.rmSync(path.join(dataDir, 'models', file.name), { force: true })
    }
  }
  fs.rmSync(path.join(dataDir, 'models', 'active-model.json'), { force: true })
  fs.rmSync(path.join(dataDir, 'models', 'active-modalities.json'), { force: true })
})

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('model-manager GGUF integrity', () => {
  it('rejects a truncated GGUF download before promotion or installation', async () => {
    const truncated = Buffer.from('GGUF', 'ascii')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Promise.resolve(
          new Response(truncated, {
            status: 200,
            headers: { 'content-length': String(truncated.length) }
          })
        )
      )
    )

    const result = await manager.downloadModel(primary.entry.id)

    expect(result).toEqual({
      success: false,
      error: `${primary.fileName}: downloaded file is not a valid GGUF (corrupt or truncated)`
    })
    expect(fs.existsSync(primary.filePath)).toBe(false)
    expect(await manager.listInstalled()).not.toContain(primary.entry.id)
    expect(manager.downloadStatus(primary.entry.id)).toMatchObject({
      modelId: primary.entry.id,
      status: 'failed',
      error: result.error
    })
  })

  it('rejects same-shape Muse bytes when their SHA-256 does not match the shared catalog', async () => {
    const muse = CATALOG.find((entry) => entry.id === 'unsloth/Muse-Glimmer-30B-GGUF')
    if (!muse) throw new Error('Shared model catalog must include Muse Glimmer')
    const wrongBytes = Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2_000, 17)])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Promise.resolve(
          new Response(wrongBytes, {
            status: 200,
            headers: { 'content-length': String(wrongBytes.length) }
          })
        )
      )
    )

    const result = await manager.downloadModel(muse.id)

    expect(result).toEqual({
      success: false,
      error: expect.stringMatching(/checksum mismatch/i)
    })
    for (const file of muse.files) {
      expect(fs.existsSync(path.join(dataDir, 'models', file.name))).toBe(false)
      expect(fs.existsSync(path.join(dataDir, 'models', `${file.name}.part`))).toBe(false)
    }
    expect(await manager.listInstalled()).not.toContain(muse.id)
  })

  it('rejects a truncated local GGUF before copying or registration', async () => {
    const source = path.join(dataDir, 'truncated.gguf')
    fs.writeFileSync(source, Buffer.from('GGUF', 'ascii'))

    const result = await manager.importLocalModel(source)

    expect(result).toEqual({
      success: false,
      error: 'File is not a valid GGUF model (corrupt or wrong format)'
    })
    expect(fs.existsSync(path.join(dataDir, 'models', 'truncated.gguf'))).toBe(false)
    expect(manager.getLocalModels()).toEqual([])
  })

  it('contains and reports a disk-full write failure without disturbing installed state', async () => {
    const installedBytes = Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2_000, 3)])
    fs.writeFileSync(primary.filePath, installedBytes)
    expect(await manager.listInstalled()).toContain(primary.entry.id)

    const body = Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2_000)])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { 'content-length': String(body.length) }
          })
        )
      )
    )

    const createWriteStream = fs.createWriteStream.bind(fs)
    const capacityProbe: CapacityProbe = { acceptedBytes: 0, partialExistedAtFailure: false }
    vi.spyOn(fs, 'createWriteStream').mockImplementation((target, options) => {
      if (target === `${diskFailure.filePath}.part`) {
        return capacityLimitedFileStream(String(target), 512, capacityProbe)
      }
      return createWriteStream(target, options)
    })

    const result = await manager.downloadModel(diskFailure.entry.id)

    expect(result).toEqual({
      success: false,
      error: 'ENOSPC: no space left on device, write'
    })
    expect(fs.existsSync(diskFailure.filePath)).toBe(false)
    expect(fs.existsSync(`${diskFailure.filePath}.part`)).toBe(false)
    expect(capacityProbe).toEqual({ acceptedBytes: 512, partialExistedAtFailure: true })
    expect(fs.readFileSync(primary.filePath)).toEqual(installedBytes)
    expect(await manager.listInstalled()).toContain(primary.entry.id)
    expect(await manager.listInstalled()).not.toContain(diskFailure.entry.id)
    expect(manager.downloadStatus(diskFailure.entry.id)).toMatchObject({
      modelId: diskFailure.entry.id,
      status: 'failed',
      error: result.error
    })
  })

  it('restores an interrupted download after restart and resumes it without corruption', async () => {
    const complete = Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2_000, 7)])
    const splitAt = 700
    const prefix = complete.subarray(0, splitAt)
    const suffix = complete.subarray(splitAt)
    let delivery = 0
    let retryRange: string | undefined

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input, init?: RequestInit) => {
        delivery++
        if (delivery === 1) {
          let pull = 0
          const interruptedBody = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (pull++ === 0) {
                controller.enqueue(prefix)
                return
              }
              controller.error(new Error('network connection interrupted'))
            }
          })
          return new Response(interruptedBody, {
            status: 200,
            headers: { 'content-length': String(complete.length) }
          })
        }

        retryRange = new Headers(init?.headers).get('range') ?? undefined
        return new Response(suffix, {
          status: 206,
          headers: { 'content-length': String(suffix.length) }
        })
      })
    )

    const firstAttempt = await manager.downloadModel(interrupted.entry.id)

    expect(firstAttempt).toEqual({ success: false, error: 'network connection interrupted' })
    expect(fs.readFileSync(`${interrupted.filePath}.part`)).toEqual(prefix)
    expect(fs.existsSync(interrupted.filePath)).toBe(false)

    vi.resetModules()
    const restartedManager = await import('../../models-manager')
    expect(restartedManager.listDownloads()).toContainEqual(
      expect.objectContaining({
        modelId: interrupted.entry.id,
        status: 'failed',
        error: 'network connection interrupted'
      })
    )

    const retry = await restartedManager.retryDownload(interrupted.entry.id)

    expect(retry).toEqual({ success: true })
    expect(retryRange).toBe(`bytes=${prefix.length}-`)
    expect(fs.readFileSync(interrupted.filePath)).toEqual(complete)
    expect(fs.existsSync(`${interrupted.filePath}.part`)).toBe(false)
    expect(await restartedManager.listInstalled()).toContain(interrupted.entry.id)

    vi.resetModules()
    const finalRestart = await import('../../models-manager')
    expect(finalRestart.listDownloads().map((download) => download.modelId)).not.toContain(
      interrupted.entry.id
    )
  })

  it('reports an offline download clearly and keeps retry plus installed state usable', async () => {
    const validGguf = Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2_000, 9)])
    fs.writeFileSync(primary.filePath, validGguf)
    expect(await manager.listInstalled()).toContain(primary.entry.id)

    const offlineCause = Object.assign(new Error('getaddrinfo ENOTFOUND huggingface.co'), {
      code: 'ENOTFOUND'
    })
    const offlineError = Object.assign(new TypeError('fetch failed'), { cause: offlineCause })
    let attempts = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (attempts++ === 0) throw offlineError
        return new Response(validGguf, {
          status: 200,
          headers: { 'content-length': String(validGguf.length) }
        })
      })
    )

    const firstAttempt = await manager.downloadModel(offline.entry.id)

    expect(firstAttempt).toEqual({
      success: false,
      error: NETWORK_UNAVAILABLE_MESSAGE
    })
    expect(fs.existsSync(offline.filePath)).toBe(false)
    expect(fs.existsSync(`${offline.filePath}.part`)).toBe(false)
    expect(await manager.listInstalled()).not.toContain(offline.entry.id)
    expect(await manager.listInstalled()).toContain(primary.entry.id)
    expect(manager.downloadStatus(offline.entry.id)).toMatchObject({
      modelId: offline.entry.id,
      status: 'failed',
      error: firstAttempt.error
    })

    const retry = await manager.retryDownload(offline.entry.id)

    expect(retry).toEqual({ success: true })
    expect(fs.readFileSync(offline.filePath)).toEqual(validGguf)
    expect(fs.existsSync(`${offline.filePath}.part`)).toBe(false)
    expect(await manager.listInstalled()).toEqual(
      expect.arrayContaining([primary.entry.id, offline.entry.id])
    )
  })
})

describe('active model deletion', () => {
  it.each(activeSelectionFixtures)(
    'clears the persisted $kind selection when its installed model is deleted',
    async ({ entry }) => {
      for (const file of entry.files) {
        fs.writeFileSync(path.join(dataDir, 'models', file.name), Buffer.alloc(2_048, 1))
      }
      expect(await manager.listInstalled()).toContain(entry.id)

      expect(await manager.activateModel(entry.id)).toEqual({ success: true })
      expect(await manager.getActiveModelIds()).toContain(entry.id)

      const deletion = await manager.deleteModel(entry.id)

      expect(deletion).toEqual({ success: true, freedFiles: entry.files.length })
      expect(await manager.getActiveModelIds()).not.toContain(entry.id)
      expect(manager.getActiveModalities()).toEqual({
        text: null,
        image: null,
        speech: null,
        transcription: null
      })
      for (const file of entry.files) {
        expect(fs.existsSync(path.join(dataDir, 'models', file.name))).toBe(false)
      }

      vi.resetModules()
      const restartedManager = await import('../../models-manager')
      expect(restartedManager.getActiveModalities()).toEqual({
        text: null,
        image: null,
        speech: null,
        transcription: null
      })
      expect(await restartedManager.getActiveModelIds()).not.toContain(entry.id)
    }
  )
})

describe('active model persistence', () => {
  it('keeps the selected chat (vision) model active after a module-style relaunch', async () => {
    // The chat model is a vision model now (no standalone text kind).
    const text = activeSelectionFixtures.find(({ kind }) => kind === 'vision')
    if (!text) throw new Error('Model catalog needs an installable vision fixture')

    for (const file of text.entry.files) {
      fs.writeFileSync(path.join(dataDir, 'models', file.name), Buffer.alloc(2_048, 1))
    }

    expect(await manager.activateModel(text.entry.id)).toEqual({ success: true })
    expect(manager.getActiveModalities().text).toBe(text.entry.id)
    expect(await manager.getActiveModelIds()).toContain(text.entry.id)

    vi.resetModules()
    const restartedManager = await import('../../models-manager')

    expect(restartedManager.getActiveModalities().text).toBe(text.entry.id)
    expect(await restartedManager.getActiveModelIds()).toContain(text.entry.id)
  })

  it('keeps every selected modal model active after a module-style relaunch', async () => {
    const modalModels = activeSelectionFixtures.filter(({ kind }) =>
      ['image', 'voice', 'transcription'].includes(kind)
    )
    if (modalModels.length !== 3) {
      throw new Error('Model catalog needs installable image, voice, and transcription fixtures')
    }

    for (const { entry } of modalModels) {
      for (const file of entry.files) {
        fs.writeFileSync(path.join(dataDir, 'models', file.name), Buffer.alloc(2_048, 1))
      }
      expect(await manager.activateModel(entry.id)).toEqual({ success: true })
    }

    const selectedIds = modalModels.map(({ entry }) => entry.id)
    expect(await manager.getActiveModelIds()).toEqual(expect.arrayContaining(selectedIds))
    const activeBeforeRestart = manager.getActiveModalities()
    expect(activeBeforeRestart).toMatchObject({
      image: expect.any(String),
      speech: expect.any(String),
      transcription: expect.any(String)
    })

    vi.resetModules()
    const restartedManager = await import('../../models-manager')

    expect(await restartedManager.getActiveModelIds()).toEqual(expect.arrayContaining(selectedIds))
    expect(restartedManager.getActiveModalities()).toEqual(activeBeforeRestart)
  })
})
