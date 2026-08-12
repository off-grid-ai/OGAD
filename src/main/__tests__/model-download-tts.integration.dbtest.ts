/**
 * Release journey #20 across real model download, activation, SQLite residency,
 * and TTS output validation. HTTP and the heavyweight ONNX worker are the only
 * controlled boundaries; every Off Grid owner between them stays production.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-model-download-tts-'))
const dataDir = path.join(root, 'data')
const resourceDir = path.join(root, 'resources')
const originalDataDir = process.env.OFFGRID_DATA_DIR
const originalResourceDir = process.env.OFFGRID_RESOURCE_DIR
process.env.OFFGRID_DATA_DIR = dataDir
process.env.OFFGRID_RESOURCE_DIR = resourceDir

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

const manager = await import('../models-manager')
const { CATALOG } = await import('@offgrid/models')
type ModelDownloadProgress = import('../models-manager').DownloadProgress
const ttsModel = CATALOG.find(
  (candidate) => candidate.kind === 'voice' && candidate.files.length === 2
)
if (!ttsModel) throw new Error('Model catalog needs a multi-file voice fixture')

interface PendingResponse {
  url: string
  resolve: (response: Response) => void
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the TTS download boundary')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

afterAll(async () => {
  await manager.deleteModel(ttsModel.id)
  await manager.clearDownload(ttsModel.id)
  const database = await import('../database')
  database.getDB().close()
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  if (originalResourceDir === undefined) delete process.env.OFFGRID_RESOURCE_DIR
  else process.env.OFFGRID_RESOURCE_DIR = originalResourceDir
  fs.rmSync(root, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

describe('TTS model download integration', () => {
  it('stays unavailable until every file lands, then selects and speaks a reply (#20)', async () => {
    fs.mkdirSync(resourceDir, { recursive: true })
    fs.writeFileSync(
      path.join(resourceDir, 'tts-worker.mjs'),
      [
        "import fs from 'node:fs'",
        'const [, , command, output] = process.argv',
        "if (command === 'speak' && output) {",
        "  let input = ''",
        "  process.stdin.setEncoding('utf8')",
        "  process.stdin.on('data', chunk => { input += chunk })",
        "  process.stdin.on('end', () => {",
        "    fs.writeFileSync(output + '.input', input)",
        "    fs.writeFileSync(output, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(60, 1)]))",
        '  })',
        '}'
      ].join('\n'),
      { mode: 0o755 }
    )

    const pending: PendingResponse[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (input: string | URL | Request) =>
          new Promise<Response>((resolve) => pending.push({ url: String(input), resolve }))
      )
    )
    const progress: ModelDownloadProgress[] = []
    const download = manager.downloadModel(ttsModel.id, (event) => progress.push(event))

    for (const [index, file] of ttsModel.files.entries()) {
      await waitFor(() => pending.length === index + 1)
      expect(pending[index]!.url).toBe(file.url)
      expect(await manager.listInstalled()).not.toContain(ttsModel.id)

      const body = Buffer.from(`off-grid-${file.name}-${index}`)
      pending[index]!.resolve(
        new Response(new Uint8Array(body), {
          status: 200,
          headers: { 'content-length': String(body.length) }
        })
      )
      if (index < ttsModel.files.length - 1) {
        await waitFor(() => pending.length === index + 2)
        expect(await manager.listInstalled()).not.toContain(ttsModel.id)
      }
    }

    await expect(download).resolves.toEqual({ success: true })
    expect(progress.at(-1)).toMatchObject({ status: 'completed', percent: 100 })
    expect(await manager.listInstalled()).toContain(ttsModel.id)
    expect(await manager.activateModel(ttsModel.id)).toEqual({ success: true })
    expect(manager.getActiveModalities().speech).toBe(ttsModel.id)

    // Plain text, because that is what this service is handed. Turning markdown into speakable text is
    // the RENDERER's job and deliberately so - src/main/tts.ts says as much, since the stripping reuses
    // the chat UI's markdown AST, and toSpeakableText has its own cases in
    // src/renderer/src/lib/__tests__/speakable.test.ts. Feeding markdown in here and expecting it back
    // stripped asserted a responsibility this file does not own, and would go green only by duplicating
    // the AST in the main process.
    const { synthesize } = await import('../tts')
    const spoken = await synthesize('A local reply with code')

    expect(spoken.dataUrl).toMatch(/^data:audio\/wav;base64,/)
    expect(
      Buffer.from(spoken.dataUrl.split(',')[1]!, 'base64').subarray(0, 4).toString('ascii')
    ).toBe('RIFF')

    const workerInput = fs
      .readdirSync(os.tmpdir())
      .filter(
        (name) => name.startsWith(`offgrid-tts-${process.pid}-`) && name.endsWith('.wav.input')
      )
      .map((name) => ({ name, mtime: fs.statSync(path.join(os.tmpdir(), name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0]
    expect(workerInput).toBeDefined()
    // Byte-identical: whatever the caller asked to be spoken is exactly what reaches the worker, with
    // nothing rewritten on the way through.
    expect(fs.readFileSync(path.join(os.tmpdir(), workerInput!.name), 'utf8')).toBe(
      'A local reply with code'
    )
    fs.unlinkSync(path.join(os.tmpdir(), workerInput!.name))
  })
})
