// Exercises the real model-manager ingress paths against a temporary models
// directory. Network delivery is the only boundary fake; validation, streaming,
// filesystem promotion, registry state, and installed-model discovery stay real.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { Writable } from 'stream'
import { NETWORK_UNAVAILABLE_MESSAGE } from '@offgrid/models'

const originalDataDir = process.env.OFFGRID_DATA_DIR
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-model-integrity-'))
process.env.OFFGRID_DATA_DIR = dataDir

await import('../../model-services')
const manager = {
  ...(await import('../../models-manager')),
  ...(await import('./download-facade-test-client'))
}
const { CATALOG } = await import('@offgrid/models')

const unavailableSource = CATALOG.find((entry) => entry.kind === 'computer_use')
if (!unavailableSource) throw new Error('Model catalog needs a Computer Use fixture')
const unavailableModel = {
  ...unavailableSource,
  id: 'offgrid-test/unavailable-computer-use',
  name: 'Unavailable Computer Use fixture',
  availability: 'coming_soon' as const,
  availabilityNote: 'This Computer Use model has no runtime adapter.'
}

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

// Runtime-managed voice assets do not enter this file-backed integrity path. Their native adapter
// owns installation and readiness; this suite covers only catalog-delivered artifacts.
const activeSelectionFixtures = ['vision', 'image', 'computer_use', 'transcription'].map((kind) => {
  const entry = CATALOG.find(
    (candidate) =>
      candidate.kind === kind &&
      candidate.files.length > 0 &&
      candidate.availability !== 'coming_soon'
  )
  if (!entry) throw new Error(`Model catalog needs an installable ${kind} fixture`)
  return { kind, entry }
})

const [primary, diskFailure, interrupted] = fixtures
if (!primary || !diskFailure || !interrupted) {
  throw new Error('Model catalog needs three single-file GGUF fixtures')
}

const invalidRetryBytes = Buffer.concat([Buffer.from('XXXX', 'ascii'), Buffer.alloc(2_000)])
const validRetryBytes = Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2_000)])
const checksumExpectedBytes = Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2_000, 11)])
const checksumWrongBytes = Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2_000, 17)])
const checksumFileName = 'offgrid-checksum-fixture.gguf'
const checksumModel = {
  ...primary.entry,
  id: 'offgrid-test/checksum',
  name: 'Checksum fixture',
  files: [
    {
      ...primary.entry.files[0]!,
      name: checksumFileName,
      url: 'https://example.invalid/offgrid-checksum-fixture.gguf',
      sizeBytes: checksumExpectedBytes.length,
      sha256: createHash('sha256').update(checksumExpectedBytes).digest('hex')
    }
  ]
}
const checksumPath = path.join(dataDir, 'models', checksumFileName)
const interruptedBytes = Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2_000, 7)])
const interruptedFileName = 'offgrid-interrupted-fixture.gguf'
const interruptedModel = {
  ...primary.entry,
  id: 'offgrid-test/interrupted',
  name: 'Interrupted fixture',
  files: [
    {
      ...primary.entry.files[0]!,
      name: interruptedFileName,
      url: 'https://example.invalid/offgrid-interrupted-fixture.gguf',
      sizeBytes: interruptedBytes.length,
      sha256: undefined
    }
  ]
}
const interruptedPath = path.join(dataDir, 'models', interruptedFileName)
const invalidRetryFileName = 'offgrid-invalid-retry.gguf'
const invalidRetryModel = {
  ...primary.entry,
  id: 'offgrid-test/invalid-retry',
  name: 'Invalid retry fixture',
  files: [
    {
      ...primary.entry.files[0]!,
      name: invalidRetryFileName,
      url: 'https://example.invalid/offgrid-invalid-retry.gguf',
      sizeBytes: validRetryBytes.length,
      sha256: undefined
    }
  ]
}
const invalidRetryPath = path.join(dataDir, 'models', invalidRetryFileName)
const offlineRetryFileName = 'offgrid-offline-retry.gguf'
const offlineRetryModel = {
  ...primary.entry,
  id: 'offgrid-test/offline-retry',
  name: 'Offline retry fixture',
  files: [
    {
      ...primary.entry.files[0]!,
      name: offlineRetryFileName,
      url: 'https://example.invalid/offgrid-offline-retry.gguf',
      sizeBytes: validRetryBytes.length,
      sha256: undefined
    }
  ]
}
const offlineRetryPath = path.join(dataDir, 'models', offlineRetryFileName)

const testCatalogEntries = [
  unavailableModel,
  invalidRetryModel,
  offlineRetryModel,
  checksumModel,
  interruptedModel
]

function registerTestCatalogEntries(catalog: typeof CATALOG): void {
  for (const entry of testCatalogEntries) {
    if (!catalog.some((candidate) => candidate.id === entry.id)) catalog.push(entry)
  }
}

function huggingFaceMetadata(input: RequestInfo | URL): Response | null {
  const url = new URL(String(input))
  const match = /^\/api\/models\/(.+)\/revision\/([^/]+)$/.exec(url.pathname)
  if (url.hostname !== 'huggingface.co' || !match) return null
  const repository = decodeURIComponent(match[1]!)
  const requestedRevision = decodeURIComponent(match[2]!)
  const files = CATALOG.flatMap((entry) =>
    entry.files.filter((file) => file.url.includes(`huggingface.co/${repository}/resolve/`))
  )
  const sha = /^[a-f0-9]{40}$/i.test(requestedRevision) ? requestedRevision : 'a'.repeat(40)
  return Response.json({
    sha,
    siblings: files.map((file) => ({
      rfilename: decodeURIComponent(new URL(file.url).pathname.split('/').slice(5).join('/')),
      size: file.sizeBytes,
      ...(file.sha256
        ? { lfs: { sha256: file.sha256, size: file.sizeBytes } }
        : {})
    }))
  })
}

function stubArtifactFetch(
  deliver: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      huggingFaceMetadata(input) ?? deliver(input, init)
    )
  )
}

interface CapacityProbe {
  acceptedBytes: number
  partialExistedAtFailure: boolean
}

function findDescendant(root: string, matches: (name: string) => boolean): string | undefined {
  if (!fs.existsSync(root)) return undefined
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const nested = findDescendant(candidate, matches)
      if (nested) return nested
    } else if (matches(entry.name)) {
      return candidate
    }
  }
  return undefined
}

function stagedPart(fileName: string): string | undefined {
  return findDescendant(
    path.join(dataDir, 'models', 'offgrid-download-staging'),
    (name) => name === fileName || name.endsWith(`-${fileName}.part`)
  )
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
  registerTestCatalogEntries(CATALOG)
  fs.mkdirSync(path.dirname(primary.filePath), { recursive: true })
})

beforeEach(async () => {
  registerTestCatalogEntries((await import('@offgrid/models')).CATALOG)
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
  fs.rmSync(invalidRetryPath, { force: true })
  fs.rmSync(`${invalidRetryPath}.part`, { force: true })
  fs.rmSync(offlineRetryPath, { force: true })
  fs.rmSync(`${offlineRetryPath}.part`, { force: true })
  fs.rmSync(checksumPath, { force: true })
  fs.rmSync(`${checksumPath}.part`, { force: true })
  fs.rmSync(interruptedPath, { force: true })
  fs.rmSync(`${interruptedPath}.part`, { force: true })
})

afterAll(() => {
  for (const fixtureId of [
    unavailableModel.id,
    invalidRetryModel.id,
    offlineRetryModel.id,
    checksumModel.id,
    interruptedModel.id
  ]) {
    const fixtureIndex = CATALOG.findIndex((entry) => entry.id === fixtureId)
    if (fixtureIndex >= 0) CATALOG.splice(fixtureIndex, 1)
  }
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('model-manager GGUF integrity', () => {
  it('refuses an unavailable Computer Use model before any network or disk work', async () => {
    const fetchBoundary = vi.fn()
    vi.stubGlobal('fetch', fetchBoundary)
    const modelsDir = path.join(dataDir, 'models')
    const result = await manager.downloadModel(unavailableModel.id)

    expect(result).toEqual({ success: false, error: unavailableModel.availabilityNote })
    expect(fetchBoundary).not.toHaveBeenCalled()
    expect(findDescendant(modelsDir, (name) => name.endsWith('.part'))).toBeUndefined()
    expect(await manager.listInstalled()).not.toContain(unavailableModel.id)
    await expect(manager.loadComputerUseModel(unavailableModel.id)).resolves.toEqual({
      success: false,
      error: unavailableModel.availabilityNote
    })
  })

  it('rejects a truncated GGUF download before promotion or installation', async () => {
    const truncated = Buffer.from('GGUF', 'ascii')
    stubArtifactFetch(async () =>
      Promise.resolve(
        new Response(truncated, {
          status: 200,
          headers: { 'content-length': String(truncated.length) }
        })
      )
    )

    const result = await manager.downloadModel(primary.entry.id)

    expect(result).toEqual({
      success: false,
      error: expect.stringMatching(
        new RegExp(`${primary.fileName}.*transferred file size does not match the manifest`)
      )
    })
    expect(fs.existsSync(primary.filePath)).toBe(false)
    expect(fs.existsSync(`${primary.filePath}.part`)).toBe(false)
    expect(await manager.listInstalled()).not.toContain(primary.entry.id)
    expect(await manager.downloadStatus(primary.entry.id)).toMatchObject({
      modelId: primary.entry.id,
      status: 'failed',
      error: result.error
    })

    const cleared = await manager.clearDownload(primary.entry.id)
    expect(cleared).toMatchObject({ success: true, freedBytes: 0 })
    expect(fs.existsSync(`${primary.filePath}.part`)).toBe(false)
    expect(await manager.downloadStatus(primary.entry.id)).toBeNull()
  })

  it('retries an invalid completed GGUF from byte zero', async () => {
    const requests: Array<RequestInit | undefined> = []
    let attempt = 0
    stubArtifactFetch(async (_url, init) => {
        requests.push(init)
        const bytes = attempt++ === 0 ? invalidRetryBytes : validRetryBytes
        return new Response(bytes, {
          status: 200,
          headers: { 'content-length': String(bytes.length) }
        })
      })

    const firstAttempt = await manager.downloadModel(invalidRetryModel.id)

    expect(firstAttempt).toEqual({
      success: false,
      error: expect.stringContaining('downloaded file is not a valid GGUF (corrupt or truncated)')
    })
    expect(fs.existsSync(invalidRetryPath)).toBe(false)
    expect(fs.existsSync(`${invalidRetryPath}.part`)).toBe(false)
    expect(await manager.downloadStatus(invalidRetryModel.id)).toMatchObject({ status: 'failed' })

    const retry = await manager.retryDownload(invalidRetryModel.id)

    expect(retry).toEqual({ success: true })
    expect(requests).toHaveLength(2)
    expect(requests[1]?.headers).toBeUndefined()
    expect(fs.readFileSync(invalidRetryPath)).toEqual(validRetryBytes)
    expect(await manager.listInstalled()).toContain(invalidRetryModel.id)
  })

  it('rejects same-shape catalog bytes when their SHA-256 does not match', async () => {
    stubArtifactFetch(async () =>
      Promise.resolve(
        new Response(checksumWrongBytes, {
          status: 200,
          headers: { 'content-length': String(checksumWrongBytes.length) }
        })
      )
    )

    const result = await manager.downloadModel(checksumModel.id)

    expect(result).toEqual({
      success: false,
      error: expect.stringMatching(/checksum/i)
    })
    expect(fs.existsSync(checksumPath)).toBe(false)
    expect(fs.existsSync(`${checksumPath}.part`)).toBe(false)
    expect(await manager.listInstalled()).not.toContain(checksumModel.id)
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
    stubArtifactFetch(async () =>
      Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { 'content-length': String(body.length) }
        })
      )
    )

    const createWriteStream = fs.createWriteStream.bind(fs)
    const capacityProbe: CapacityProbe = { acceptedBytes: 0, partialExistedAtFailure: false }
    vi.spyOn(fs, 'createWriteStream').mockImplementation((target, options) => {
      if (String(target).endsWith(`-${diskFailure.fileName}.part`)) {
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
    expect(fs.readFileSync(stagedPart(diskFailure.fileName)!)).toEqual(body.subarray(0, 512))
    expect(capacityProbe).toEqual({ acceptedBytes: 512, partialExistedAtFailure: true })
    expect(fs.readFileSync(primary.filePath)).toEqual(installedBytes)
    expect(await manager.listInstalled()).toContain(primary.entry.id)
    expect(await manager.listInstalled()).not.toContain(diskFailure.entry.id)
    expect(await manager.downloadStatus(diskFailure.entry.id)).toMatchObject({
      modelId: diskFailure.entry.id,
      status: 'failed',
      error: result.error
    })
  })

  it('restores an interrupted download after restart and resumes it without corruption', async () => {
    const complete = interruptedBytes
    const splitAt = 700
    const prefix = complete.subarray(0, splitAt)
    const suffix = complete.subarray(splitAt)
    let delivery = 0
    let retryRange: string | undefined

    stubArtifactFetch(async (_input, init) => {
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
          headers: {
            'content-length': String(suffix.length),
            'content-range': `bytes ${prefix.length}-${complete.length - 1}/${complete.length}`
          }
        })
      })

    const firstAttempt = await manager.downloadModel(interruptedModel.id)

    expect(firstAttempt).toEqual({ success: false, error: 'network connection interrupted' })
    expect(fs.readFileSync(stagedPart(interruptedFileName)!)).toEqual(prefix)
    expect(fs.existsSync(interruptedPath)).toBe(false)

    vi.resetModules()
    registerTestCatalogEntries((await import('@offgrid/models')).CATALOG)
    await import('../../model-services')
    const restartedManager = {
      ...(await import('../../models-manager')),
      ...(await import('./download-facade-test-client'))
    }
    expect(await restartedManager.listDownloads()).toContainEqual(
      expect.objectContaining({
        modelId: interruptedModel.id,
        status: 'failed',
        error: 'network connection interrupted'
      })
    )

    const retry = await restartedManager.retryDownload(interruptedModel.id)

    expect(retry).toEqual({ success: true })
    expect(retryRange).toBe(`bytes=${prefix.length}-`)
    expect(fs.readFileSync(interruptedPath)).toEqual(complete)
    expect(fs.existsSync(`${interruptedPath}.part`)).toBe(false)
    expect(await restartedManager.listInstalled()).toContain(interruptedModel.id)

    vi.resetModules()
    registerTestCatalogEntries((await import('@offgrid/models')).CATALOG)
    await import('../../model-services')
    const finalRestart = {
      ...(await import('../../models-manager')),
      ...(await import('./download-facade-test-client'))
    }
    expect(await finalRestart.listDownloads()).toContainEqual(
      expect.objectContaining({ modelId: interruptedModel.id, status: 'completed' })
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
    stubArtifactFetch(async () => {
        if (attempts++ === 0) throw offlineError
        return new Response(validGguf, {
          status: 200,
          headers: { 'content-length': String(validGguf.length) }
        })
      })

    const firstAttempt = await manager.downloadModel(offlineRetryModel.id)

    expect(firstAttempt).toEqual({
      success: false,
      error: NETWORK_UNAVAILABLE_MESSAGE
    })
    expect(fs.existsSync(offlineRetryPath)).toBe(false)
    expect(fs.existsSync(`${offlineRetryPath}.part`)).toBe(false)
    expect(await manager.listInstalled()).not.toContain(offlineRetryModel.id)
    expect(await manager.listInstalled()).toContain(primary.entry.id)
    expect(await manager.downloadStatus(offlineRetryModel.id)).toMatchObject({
      modelId: offlineRetryModel.id,
      status: 'failed',
      error: firstAttempt.error
    })

    const retry = await manager.retryDownload(offlineRetryModel.id)

    expect(retry).toEqual({ success: true })
    expect(fs.readFileSync(offlineRetryPath)).toEqual(validGguf)
    expect(fs.existsSync(`${offlineRetryPath}.part`)).toBe(false)
    expect(await manager.listInstalled()).toEqual(
      expect.arrayContaining([primary.entry.id, offlineRetryModel.id])
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
        computer_use: null,
        image: null,
        speech: null,
        transcription: null
      })
      for (const file of entry.files) {
        expect(fs.existsSync(path.join(dataDir, 'models', file.name))).toBe(false)
      }

      vi.resetModules()
      await import('../../model-services')
      const restartedManager = {
        ...(await import('../../models-manager')),
        ...(await import('./download-facade-test-client'))
      }
      await restartedManager.listDownloads()
      expect(restartedManager.getActiveModalities()).toEqual({
        text: null,
        computer_use: null,
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
    await import('../../model-services')
    const restartedManager = {
      ...(await import('../../models-manager')),
      ...(await import('./download-facade-test-client'))
    }
    await restartedManager.listDownloads()

    expect(restartedManager.getActiveModalities().text).toBe(text.entry.id)
    expect(await restartedManager.getActiveModelIds()).toContain(text.entry.id)
  })

  it('keeps every selected modal model active after a module-style relaunch', async () => {
    const modalModels = activeSelectionFixtures.filter(({ kind }) =>
      ['computer_use', 'image', 'transcription'].includes(kind)
    )
    if (modalModels.length !== 3) {
      throw new Error(
        'Model catalog needs installable computer use, image, and transcription fixtures'
      )
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
      computer_use: expect.any(String),
      image: expect.any(String),
      transcription: expect.any(String)
    })

    vi.resetModules()
    await import('../../model-services')
    const restartedManager = {
      ...(await import('../../models-manager')),
      ...(await import('./download-facade-test-client'))
    }
    await restartedManager.listDownloads()

    expect(await restartedManager.getActiveModelIds()).toEqual(expect.arrayContaining(selectedIds))
    expect(restartedManager.getActiveModalities()).toEqual(activeBeforeRestart)
  })
})
