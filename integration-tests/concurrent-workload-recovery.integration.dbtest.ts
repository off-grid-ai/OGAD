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
    // shipped for chat is multimodal. The old filter also demanded a single file, and none qualify now
    // either - a chat model carries an mmproj beside its weights - so this takes the first file of each,
    // which is the one the transfer below interrupts and resumes.
    const models = CATALOG.filter((candidate) => candidate.kind === 'vision').slice(0, 4)
    if (models.length < 4) throw new Error('Model catalog needs four chat models for this journey')

    const conversationId = 'concurrent-workload-recovery'
    database.createRagConversation(conversationId, 'Concurrent workload recovery')
    database.addRagMessage(
      conversationId,
      'user',
      'Keep this chat while downloads are interrupted.'
    )

    const transfers: TransferBoundary[] = models.slice(0, 3).map((model, index) => {
      const fileName = model.files[0]!.name
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

    // This is the exact durable filesystem state an abrupt process exit leaves behind.
    const crashRegistry = fs.readFileSync(path.join(modelsDir, 'downloads.json'))
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
    vi.resetModules()
    const [relaunchedDatabase, relaunchedManager] = await Promise.all([
      import('../src/main/database'),
      import('../src/main/models-manager')
    ])
    expect(relaunchedManager.listDownloads()).toEqual(
      expect.arrayContaining(
        models.map((model) =>
          expect.objectContaining({
            modelId: model.id,
            status: 'failed',
            error: relaunchedManager.DOWNLOAD_INTERRUPTED_ERROR
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

    const resume = transfers[0]!
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        // Two files per model, and they resume differently. The interrupted one asks to continue from the
        // bytes already on disk and gets a 206 with the remainder; its companion (a chat model carries an
        // mmproj beside its weights) was never started, so it asks for the whole file and gets a 200. A
        // fake that demanded a Range on every request failed on the companion - and would have hidden a
        // real bug the other way round, a resumed file re-fetched from zero.
        const headers = (init?.headers ?? {}) as Record<string, string>
        if (headers.Range) {
          expect(headers).toEqual({ Range: `bytes=${String(resume.prefix.length)}-` })
          const remainder = resume.full.subarray(resume.prefix.length)
          return Promise.resolve(
            new Response(new Uint8Array(remainder), {
              status: 206,
              headers: { 'content-length': String(remainder.length) }
            })
          )
        }
        const companion = gguf(90)
        return Promise.resolve(
          new Response(new Uint8Array(companion), {
            status: 200,
            headers: { 'content-length': String(companion.length) }
          })
        )
      })
    )
    await expect(relaunchedManager.retryDownload(resume.modelId)).resolves.toEqual({
      success: true
    })
    expect(fs.readFileSync(path.join(relaunchedProfile, 'models', resume.fileName))).toEqual(
      resume.full
    )
    expect(fs.existsSync(path.join(relaunchedProfile, 'models', `${resume.fileName}.part`))).toBe(
      false
    )

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
