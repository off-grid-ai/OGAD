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
  remoteFile: string
  full: Buffer
  prefix: Buffer
}

function huggingFaceArtifact(rawUrl: string): { repo: string; file: string } | undefined {
  const match = /^\/([^/]+\/[^/]+)\/resolve\/[^/]+\/(.+)$/.exec(new URL(rawUrl).pathname)
  return match ? { repo: match[1]!, file: decodeURIComponent(match[2]!) } : undefined
}

function gguf(seed: number): Buffer {
  return Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(64 * 1_024 - 4, seed)])
}

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!(await condition())) {
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
    const [{ CATALOG, DOWNLOAD_INTERRUPTED_ERROR }, database, shutdown] = await Promise.all([
      import('@offgrid/models'),
      import('../src/main/database'),
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
      const file = model.files.find((candidate) => candidate.role === 'primary') ?? model.files[0]!
      const address = huggingFaceArtifact(file.url)
      if (!address || address.repo !== model.id)
        throw new Error(`Invalid Hugging Face primary artifact for ${model.id}`)
      const full = gguf(20 + index)
      return {
        modelId: model.id,
        fileName: file.name,
        remoteFile: address.file,
        full,
        // Cross the fs.WriteStream high-water mark so the partial is observably durable
        // while the controlled HTTP body remains open, just like a large real model.
        prefix: full.subarray(0, 32 * 1_024)
      }
    })
    const transferFor = (rawUrl: string): TransferBoundary | undefined => {
      const address = huggingFaceArtifact(rawUrl)
      return address
        ? transfers.find(
            (candidate) =>
              candidate.modelId === address.repo && candidate.remoteFile === address.file
          )
        : undefined
    }
    const metadata = (rawUrl: string): Response | undefined => {
      const match = /^\/api\/models\/(.+)\/revision\//.exec(new URL(rawUrl).pathname)
      if (!match) return undefined
      const model = models.find((candidate) => candidate.id === match[1])
      if (!model) return new Response('Not found', { status: 404 })
      return Response.json({
        sha: '0123456789abcdef0123456789abcdef01234567',
        siblings: model.files.map((file) => ({
          rfilename: huggingFaceArtifact(file.url)?.file,
          size: file.sizeBytes
        }))
      })
    }
    let fetches = 0
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const metadataResponse = metadata(input instanceof Request ? input.url : String(input))
        if (metadataResponse) return Promise.resolve(metadataResponse)
        const rawUrl = input instanceof Request ? input.url : String(input)
        const transfer = transferFor(rawUrl)
        if (!transfer)
          throw new Error(`An unexpected artifact crossed the HTTP boundary: ${rawUrl}`)
        fetches += 1
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

    const manager = await import('../src/main/models/__tests__/download-facade-test-client')
    await manager.listDownloads()
    const results = models.map((model) => manager.downloadModel(model.id))
    const modelsDir = path.join(crashedProfile, 'models')
    const downloadsFile = path.join(modelsDir, 'downloads.json')
    const stagedPartialPath = (transfer: TransferBoundary): string | undefined => {
      try {
        const records = JSON.parse(fs.readFileSync(downloadsFile, 'utf8')) as Array<{
          manifest: {
            modelId: string
            artifacts: Array<{ name: string; localName: string }>
          }
        }>
        const record = records.find((candidate) => candidate.manifest.modelId === transfer.modelId)
        const artifact = record?.manifest.artifacts.find(
          (candidate) => candidate.name === transfer.fileName
        )
        return artifact ? path.join(modelsDir, `${artifact.localName}.part`) : undefined
      } catch {
        return undefined
      }
    }
    await waitFor(async () => {
      const records = await manager.listDownloads()
      const failed = records.find((record) => record.status === 'failed')
      if (failed) throw new Error(`A concurrent download failed before shutdown: ${failed.error}`)
      return (
        fetches === 3 &&
        transfers.every((transfer) => {
          try {
            const partial = stagedPartialPath(transfer)
            return partial !== undefined && fs.statSync(partial).size === transfer.prefix.length
          } catch {
            return false
          }
        })
      )
    })
    expect(
      (await manager.listDownloads()).filter((item) => item.status === 'downloading')
    ).toHaveLength(3)
    expect((await manager.listDownloads()).filter((item) => item.status === 'queued')).toHaveLength(
      1
    )

    await waitFor(() => {
      const persisted: unknown = JSON.parse(fs.readFileSync(downloadsFile, 'utf8'))
      if (!Array.isArray(persisted)) return false
      const phases = persisted.map((record) =>
        record && typeof record === 'object' && 'phase' in record ? record.phase : undefined
      )
      return (
        phases.filter((phase) => phase === 'downloading').length === 3 &&
        phases.filter((phase) => phase === 'queued').length === 1
      )
    })
    // This is the exact durable filesystem state an abrupt process exit leaves behind.
    const crashRegistry = fs.readFileSync(downloadsFile)
    const registry = new shutdown.ShutdownRegistry()
    const stops: string[] = []
    shutdown.registerCoreShutdownOwners(registry, {
      stopGateway: () => {
        stops.push('gateway')
      },
      stopMediaServer: () => {
        stops.push('media')
      }
    })

    // The Shared application owns model generation and download workers. The Core registry owns
    // only independent Desktop sockets, so application stop must settle its active and queued work
    // before those platform resources are released.
    await manager.shutdownModelDownloads()
    await expect(registry.shutdown()).resolves.toEqual([])
    await expect(Promise.all(results)).resolves.toEqual(
      models.map(() => ({ success: false, error: DOWNLOAD_INTERRUPTED_ERROR }))
    )
    expect(stops).toEqual(['media', 'gateway'])
    expect(fetches).toBe(3)
    for (const transfer of transfers) {
      const partial = stagedPartialPath(transfer)
      expect(partial).toBeDefined()
      expect(fs.statSync(partial!).size).toBe(transfer.prefix.length)
    }
    await expect(manager.downloadModel(models[0]!.id)).resolves.toEqual({
      success: false,
      error: 'Model download coordinator is stopped'
    })

    database.getDB().close()
    fs.cpSync(crashedProfile, relaunchedProfile, { recursive: true })
    fs.writeFileSync(path.join(relaunchedProfile, 'models', 'downloads.json'), crashRegistry)

    boundary.profile = relaunchedProfile
    process.env.OFFGRID_DATA_DIR = relaunchedProfile
    const resumedFiles = new Set<string>()
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        // Explicit retry resumes interrupted work. Partial primaries use Range; untouched
        // companions start at zero.
        const rawUrl =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const metadataResponse = metadata(rawUrl)
        if (metadataResponse) return Promise.resolve(metadataResponse)
        const headers = new Headers(input instanceof Request ? input.headers : undefined)
        new Headers(init?.headers).forEach((value, name) => headers.set(name, value))
        const range = headers.get('range')
        if (range) {
          const interrupted = transferFor(rawUrl)
          if (!interrupted)
            throw new Error(`An unexpected ranged artifact crossed the boundary: ${rawUrl}`)
          expect(range).toBe(`bytes=${String(interrupted.prefix.length)}-`)
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
      import('../src/main/models/__tests__/download-facade-test-client')
    ])
    await waitFor(async () => {
      const records = await relaunchedManager.listDownloads()
      return (
        records.filter((item) => item.status === 'failed').length === 3 &&
        records.filter((item) => item.status === 'completed').length === 1
      )
    })
    expect(await relaunchedManager.listDownloads()).toEqual(
      expect.arrayContaining(
        models.slice(0, 3).map((model) =>
          expect.objectContaining({
            modelId: model.id,
            status: 'failed',
            error: DOWNLOAD_INTERRUPTED_ERROR
          })
        )
      )
    )
    expect(resumedFiles.size).toBe(0)

    await expect(
      Promise.all(models.slice(0, 3).map((model) => relaunchedManager.retryDownload(model.id)))
    ).resolves.toEqual(models.slice(0, 3).map(() => ({ success: true })))
    await waitFor(async () => {
      const records = await relaunchedManager.listDownloads()
      return (
        records.length === models.length && records.every((item) => item.status === 'completed')
      )
    })
    expect(await relaunchedManager.listDownloads()).toEqual(
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
