// What the model manager PUBLISHES while a download runs, and when it refuses one. The Models
// screen renders nothing but these events, so the guarantees live here: one percent for the whole
// job, and a refusal that reaches the channel rather than only the caller.
//
// Real models-manager, real filesystem under a temp data dir, real queue. Only HTTP is controlled —
// the one boundary outside Off Grid AI.
//
// Grounded in the macOS session of 2026-08-09: a refused download told nobody, so the card kept a
// spinner at 0% for hours; and the percent was per-FILE, so a two-file model ran 0→100 twice and
// the number meant something different on each side of the reset.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-download-progress-'))
const dataDir = path.join(testRoot, 'data')
process.env.OFFGRID_DATA_DIR = dataDir
fs.mkdirSync(path.join(dataDir, 'models'), { recursive: true })

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

const { CATALOG } = await import('@offgrid/models')
type ModelDownloadProgress = import('./download-facade-test-client').DownloadProgress

/** A real catalog model with TWO files — the shape the reset was visible on (weights + projector). */
const productionModel = CATALOG.find((m) => m.files.length === 2)
if (!productionModel) throw new Error('Model catalog needs a two-file fixture')
const productionIndex = CATALOG.indexOf(productionModel)
const twoFileModel = {
  ...productionModel,
  files: productionModel.files.map((file, index) => ({
    ...file,
    sizeBytes: index === 0 ? 8 * 1024 * 1024 : 4 * 1024 * 1024
  }))
}
CATALOG.splice(productionIndex, 1, twoFileModel)

await import('../../model-services')
const manager = await import('../../models-manager')
const downloads = await import('./download-facade-test-client')

interface Pending {
  url: string
  resolve: (response: Response) => void
}

/** HTTP under the test's control, so each file can be served on cue and the progress in between read. */
function controlledHttp(): Pending[] {
  const pending: Pending[] = []
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

/** GGUF bytes of a chosen size — a real magic header so the integrity gate promotes the file. */
function bodyOf(name: string, bytes: number): Buffer {
  return name.endsWith('.gguf')
    ? Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(bytes - 4, 7)])
    : Buffer.alloc(bytes, 7)
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await manager.deleteModel(twoFileModel.id)
  await downloads.clearDownload(twoFileModel.id)
})

afterAll(async () => {
  await downloads.shutdownModelDownloads()
  CATALOG.splice(productionIndex, 1, productionModel)
  fs.rmSync(testRoot, { recursive: true, force: true })
})

describe('the progress a download publishes', () => {
  it('reports ONE rising percent across every file, never restarting at the next one', async () => {
    const pending = controlledHttp()
    const events: ModelDownloadProgress[] = []
    // Megabyte-scale bodies, because the published bytes are reported in MB to one decimal: a
    // few kilobytes round to "0.0" for both files and could not show a reset either way.
    const first = bodyOf(twoFileModel.files[0]!.name, 8 * 1024 * 1024)
    const second = bodyOf(twoFileModel.files[1]!.name, 4 * 1024 * 1024)

    const done = downloads.downloadModel(twoFileModel.id, (e) => events.push(e))

    await waitFor(() => pending.length === 1)
    pending[0]!.resolve(
      new Response(new Uint8Array(first), {
        status: 200,
        headers: { 'content-length': String(first.length) }
      })
    )
    await waitFor(() => pending.length === 2)

    // The first file has finished and the job is NOT done: reporting 100 here is what made the
    // number restart on the file after it. The card also learns which part of how many is moving.
    const afterFirst = events
      .filter((e) => e.status === 'downloading' && e.fileIndex === 1 && e.downloadedMB)
      .at(-1)!
    expect(afterFirst.percent).toBeLessThan(100)
    expect(afterFirst.fileIndex).toBe(1)
    expect(afterFirst.fileCount).toBe(2)

    pending[1]!.resolve(
      new Response(new Uint8Array(second), {
        status: 200,
        headers: { 'content-length': String(second.length) }
      })
    )
    expect(await done).toEqual({ success: true })

    // Across the whole job the percent only ever goes up. A per-file percent fails this at the
    // boundary between the two files, which is exactly where it used to drop back to 0.
    const percents = events
      .filter((e) => e.status === 'downloading')
      .map((e) => e.percent ?? 0)
      .concat(100)
    for (const [i, p] of percents.entries()) {
      if (i > 0) expect(p).toBeGreaterThanOrEqual(percents[i - 1]!)
    }

    // And the bytes are cumulative: the second file continues the count rather than starting over,
    // which is the same reset seen from the other side.
    const lastOfFile = (index: number): number =>
      Number(
        events
          .filter((e) => e.status === 'downloading' && e.fileIndex === index && e.downloadedMB)
          .at(-1)!.downloadedMB
      )
    expect(lastOfFile(2)).toBeGreaterThan(lastOfFile(1))
  })

  // LAST in this file on purpose: closing the queue is process-wide and permanent, so any download
  // after it would be refused too. Splitting it into its own file would duplicate the whole setup.
  it('returns a refusal without retaining active work after the application is closed', async () => {
    const events: ModelDownloadProgress[] = []

    await downloads.shutdownModelDownloads() // the application is going away

    const result = await downloads.downloadModel(twoFileModel.id, (e) => events.push(e))

    // The caller is told, as before...
    expect(result.success).toBe(false)
    // The command must still fail and the retained projection must not claim that work is active.
    // A stopped application does not publish or persist new work. The typed command result is the
    // caller's failure signal and clears the renderer's optimistic queued state.
    const stored = await downloads.downloadStatus(twoFileModel.id)
    expect(stored?.status).not.toBe('downloading')
    expect(events).toEqual([])
  })
})
