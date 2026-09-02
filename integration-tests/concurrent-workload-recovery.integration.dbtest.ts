/**
 * Concurrent workload ownership across shutdown, crash recovery, and relaunch.
 *
 * The production model manager, download queue, shutdown registry, catalog, filesystem,
 * and SQLite repositories stay real. Only HTTP transfer streams and Electron's host-path/
 * safe-storage APIs are controlled boundaries.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-workload-recovery-'))
const crashedProfile = path.join(testRoot, 'crashed-profile')
const relaunchedProfile = path.join(testRoot, 'relaunched-profile')
const originalDataDir = process.env.OFFGRID_DATA_DIR
const boundary = vi.hoisted(() => ({ profile: '' }))
const restoreCatalogFacts: Array<() => void> = []

boundary.profile = crashedProfile
process.env.OFFGRID_DATA_DIR = crashedProfile

vi.mock('electron', () => ({
  app: {
    getPath: () => boundary.profile,
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getVersion: () => '0.0.40'
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

interface TransferBoundary {
  modelId: string
  fileName: string
  full: Buffer
  prefix: Buffer
}

function gguf(seed: number): Buffer {
  return Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(64 * 1_024 - 4, seed)])
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for workload boundary')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

afterAll(() => {
  for (const restore of restoreCatalogFacts.splice(0)) restore()
  vi.unstubAllGlobals()
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  fs.rmSync(testRoot, { recursive: true, force: true })
})

describe('concurrent workload shutdown and crash recovery', () => {
  it('interrupts every owned transfer, preserves resumable bytes, and relaunches cleanly', async () => {
    fs.mkdirSync(crashedProfile, { recursive: true })
    const [{ CATALOG }, database, manager, shutdown] = await Promise.all([
      import('@offgrid/models'),
      import('../src/main/database'),
      import('../src/main/models-manager'),
      import('../src/main/shutdown')
    ])
    // Chat models, which the catalog calls 'vision': no entry is kind 'text' any more, because every model
    // shipped for chat is multimodal. Shared downloads the primary runtime artifact before its
    // projector companion. This boundary observes that canonical role priority.
    const models = CATALOG.filter((candidate) => candidate.kind === 'vision').slice(0, 4)
    if (models.length < 4) throw new Error('Model catalog needs four chat models for this journey')
    // HTTP is a controlled boundary in this test. Keep the real catalog identities, roles, and
    // multi-file manifests, but scale byte-size facts to the valid GGUF fixtures served below.
    for (const model of models) {
      for (const file of model.files) {
        const mutable = file as { sizeBytes?: number; sha256?: string }
        const original = mutable.sizeBytes
        const originalSha256 = mutable.sha256
        mutable.sizeBytes = 64 * 1_024
        mutable.sha256 = undefined
        restoreCatalogFacts.push(() => {
          mutable.sizeBytes = original
          mutable.sha256 = originalSha256
        })
      }
    }

    const conversationId = 'concurrent-workload-recovery'
    database.createRagConversation(conversationId, 'Concurrent workload recovery')
    database.addRagMessage(
      conversationId,
      'user',
      'Keep this chat while downloads are interrupted.'
    )

    const transfers: TransferBoundary[] = models.slice(0, 3).map((model, index) => {
      const fileName = (model.files.find((file) => file.role === 'primary') ?? model.files[0])!.name
      const full = gguf(20 + index)
      return {
        modelId: model.id,
        fileName,
        full,
        // Cross the fs.WriteStream high-water mark so the partial is observably durable
        // while the controlled HTTP body remains open, just like a large real model.
        prefix: full.subarray(0, 32 * 1_024)
      }
    })
    let fetches = 0
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        const transfer = transfers[fetches++]
        if (!transfer) throw new Error('A queued transfer crossed the HTTP boundary')
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(transfer.prefix)
            init?.signal?.addEventListener(
              'abort',
              () =>
                controller.error(init.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
              { once: true }
            )
          }
        })
        return Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { 'content-length': String(transfer.full.length) }
          })
        )
      })
    )

    const results = models.map((model) => manager.downloadModel(model.id))
    const modelsDir = path.join(crashedProfile, 'models')
    await waitFor(
      () =>
        fetches === 3 &&
        transfers.every((transfer) => {
          try {
            return (
              fs.statSync(path.join(modelsDir, `${transfer.fileName}.part`)).size ===
              transfer.prefix.length
            )
          } catch {
            return false
          }
        })
    )
    expect(manager.listDownloads().filter((item) => item.status === 'downloading')).toHaveLength(3)
    expect(manager.listDownloads().filter((item) => item.status === 'queued')).toHaveLength(1)

    const downloadsFile = path.join(modelsDir, 'downloads.json')
    await waitFor(() => {
      const persisted: unknown = JSON.parse(fs.readFileSync(downloadsFile, 'utf8'))
      if (!Array.isArray(persisted)) return false
      const phases = persisted.map((record) =>
        record && typeof record === 'object' && 'phase' in record ? record.phase : undefined)
      return phases.filter((phase) => phase === 'downloading').length === 3 &&
        phases.filter((phase) => phase === 'queued').length === 1
    })
    // This is the exact durable filesystem state an abrupt process exit leaves behind.
    const crashRegistry = fs.readFileSync(downloadsFile)
    const registry = new shutdown.ShutdownRegistry()
    const stops: string[] = []
    shutdown.registerCoreShutdownOwners(registry, {
      stopGateway: () => stops.push('gateway'),
      stopMediaServer: () => stops.push('media'),
      stopModelRuntimes: () => stops.push('runtimes'),
      stopModelDownloads: () => manager.shutdownModelDownloads()
    })

    await expect(registry.shutdown()).resolves.toEqual([])
    await expect(Promise.all(results)).resolves.toEqual(
      models.map(() => ({ success: false, error: manager.DOWNLOAD_INTERRUPTED_ERROR }))
    )
    expect(stops).toEqual(['runtimes', 'media', 'gateway'])
    expect(fetches).toBe(3)
    for (const transfer of transfers) {
      expect(fs.statSync(path.join(modelsDir, `${transfer.fileName}.part`)).size).toBe(
        transfer.prefix.length
      )
    }
    await expect(manager.downloadModel(models[0]!.id)).resolves.toEqual({
      success: false,
      error: manager.DOWNLOAD_INTERRUPTED_ERROR
    })

    database.getDB().close()
    fs.cpSync(crashedProfile, relaunchedProfile, { recursive: true })
    fs.writeFileSync(path.join(relaunchedProfile, 'models', 'downloads.json'), crashRegistry)

    boundary.profile = relaunchedProfile
    process.env.OFFGRID_DATA_DIR = relaunchedProfile
    const resumedFiles = new Set<string>()
    let resumedIndex = 0
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        // Explicit retry resumes interrupted work. Partial primaries use Range; untouched
        // companions start at zero.
        const rawUrl = typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
        const requested = decodeURIComponent(rawUrl)
        const transfer = transfers.find((candidate) => requested.includes(candidate.fileName))
        const headers = (init?.headers ?? {}) as Record<string, string>
        if (headers.Range) {
          const interrupted = transfer ?? transfers[resumedIndex++]
          if (!interrupted) throw new Error('An unexpected extra Range request crossed the boundary')
          expect(headers).toEqual({ Range: `bytes=${String(interrupted.prefix.length)}-` })
          resumedFiles.add(interrupted.fileName)
          const remainder = interrupted.full.subarray(interrupted.prefix.length)
          return Promise.resolve(
            new Response(new Uint8Array(remainder), {
              status: 206,
              headers: { 'content-length': String(remainder.length) }
            })
          )
        }
        const complete = gguf(90)
        return Promise.resolve(
          new Response(new Uint8Array(complete), {
            status: 200,
            headers: { 'content-length': String(complete.length) }
          })
        )
      })
    )
    vi.resetModules()
    const [relaunchedDatabase, relaunchedManager] = await Promise.all([
      import('../src/main/database'),
      import('../src/main/models-manager')
    ])
    await waitFor(() => {
      const records = relaunchedManager.listDownloads()
      return records.filter((item) => item.status === 'failed').length === 3 &&
        records.filter((item) => item.status === 'completed').length === 1
    })
    expect(relaunchedManager.listDownloads()).toEqual(
      expect.arrayContaining(
        models.slice(0, 3).map((model) =>
          expect.objectContaining({
            modelId: model.id,
            status: 'failed',
            error: relaunchedManager.DOWNLOAD_INTERRUPTED_ERROR
          })
        )
      )
    )
    expect(resumedFiles.size).toBe(0)

    await expect(
      Promise.all(models.slice(0, 3).map((model) => relaunchedManager.retryDownload(model.id)))
    ).resolves.toEqual(models.slice(0, 3).map(() => ({ success: true })))
    await waitFor(
      () =>
        relaunchedManager.listDownloads().length === models.length &&
        relaunchedManager.listDownloads().every((item) => item.status === 'completed')
    )
    expect(relaunchedManager.listDownloads()).toEqual(
      expect.arrayContaining(
        models.map((model) =>
          expect.objectContaining({
            modelId: model.id,
            status: 'completed'
          })
        )
      )
    )
    expect(relaunchedDatabase.getRagMessages(conversationId)).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'Keep this chat while downloads are interrupted.'
      })
    ])
    expect(resumedFiles).toEqual(new Set(transfers.map((transfer) => transfer.fileName)))
    for (const transfer of transfers) {
      expect(fs.readFileSync(path.join(relaunchedProfile, 'models', transfer.fileName))).toEqual(
        transfer.full
      )
      expect(
        fs.existsSync(path.join(relaunchedProfile, 'models', `${transfer.fileName}.part`))
      ).toBe(false)
    }

    relaunchedDatabase.addRagMessage(
      conversationId,
      'assistant',
      'The interrupted workload resumed after relaunch.'
    )
    relaunchedDatabase.getDB().close()
    expect(
      relaunchedDatabase.getRagMessages(conversationId).map((message) => message.content)
    ).toEqual([
      'Keep this chat while downloads are interrupted.',
      'The interrupted workload resumed after relaunch.'
    ])
    relaunchedDatabase.getDB().close()
  }, 15_000)
})
