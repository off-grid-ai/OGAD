/**
 * Fresh-install release journey through the production setup planner, catalog,
 * model manager, persisted selections, and every supported modality runtime.
 *
 * Only boundaries outside Off Grid AI are controlled: HTTP serves deterministic
 * model bytes and tiny executables stand in for llama.cpp, stable-diffusion.cpp,
 * whisper.cpp, and Kokoro. The interrupted-download registry, Range resume,
 * filesystem promotion, generic activation, runtime selection, first use, and
 * relaunch behavior stay real.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WHISPER_MIN_BYTES } from '@offgrid/models'
import { modelsFailureMessage, type OffGridApplication } from '@offgrid/application'

const originalDataDir = process.env.OFFGRID_DATA_DIR
const originalBinDir = process.env.OFFGRID_BIN_DIR
const originalResourceDir = process.env.OFFGRID_RESOURCE_DIR
const originalSkipCompatibleGenerationModel = process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL
const hostFetch = globalThis.fetch.bind(globalThis)
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-fresh-setup-'))
const dataDir = path.join(root, 'profile')
const binDir = path.join(root, 'bin')
const resourceDir = path.join(root, 'resources')
process.env.OFFGRID_DATA_DIR = dataDir
process.env.OFFGRID_BIN_DIR = binDir
process.env.OFFGRID_RESOURCE_DIR = resourceDir
// This journey must start before Desktop model services create the profile.
// It installs its own real runtime boundary after proving the profile is absent.
process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL = '1'

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
  },
  ipcMain: {
    on: () => undefined,
    removeListener: () => undefined,
    handle: () => undefined,
    removeHandler: () => undefined
  }
}))

vi.spyOn(os, 'totalmem').mockReturnValue(64 * 1024 * 1024 * 1024)
vi.spyOn(os, 'freemem').mockReturnValue(48 * 1024 * 1024 * 1024)

interface CatalogFile {
  name: string
  url: string
}

interface JourneyModel {
  id: string
  kind: 'text' | 'vision' | 'image' | 'transcription' | 'voice'
  files: CatalogFile[]
}

function isFirstUseModelKind(kind: string): kind is JourneyModel['kind'] {
  return ['text', 'vision', 'image', 'transcription', 'voice'].includes(kind)
}

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const delivery = new Map<string, Buffer>()
const interrupted = new Set<string>()
const resumedRanges = new Map<string, string>()
let interruptDownloads = true
let remoteRequests = 0

type DesktopApplicationComposition = typeof import('../composition/application')

// A module reset creates a new production composition root. Keep each root until its own lifecycle
// has stopped it so a failed assertion cannot leave runtime processes, subscriptions, or adapters
// alive behind the next test.
const startedApplicationCompositions = new Set<DesktopApplicationComposition>()

async function startApplication(composition: DesktopApplicationComposition): Promise<void> {
  startedApplicationCompositions.add(composition)
  await composition.startDesktopApplication()
}

async function stopApplication(composition: DesktopApplicationComposition): Promise<void> {
  await composition.stopDesktopApplication()
  startedApplicationCompositions.delete(composition)
}

async function generatedText(prompt: string, images: string[] = []): Promise<string> {
  const { generateDesktopText } = await import('../desktop-generation')
  return (await generateDesktopText(prompt, { images, profile: 'chat' })).content
}

function executable(file: string, source: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, source, { mode: 0o755 })
}

function installRuntimeBoundaries(): void {
  executable(
    path.join(binDir, 'llama', 'llama-server'),
    [
      '#!/usr/bin/env node',
      "const http = require('node:http')",
      'const args = process.argv.slice(2)',
      "const portIndex = args.indexOf('--port')",
      'const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 8439',
      'const server = http.createServer((req, res) => {',
      "  if (req.method === 'GET' && req.url === '/health') {",
      "    res.writeHead(200, { 'content-type': 'application/json' })",
      "    res.end(JSON.stringify({ status: 'ok' }))",
      '    return',
      '  }',
      "  if (req.method === 'GET' && req.url === '/v1/models') {",
      "    res.writeHead(200, { 'content-type': 'application/json' })",
      "    res.end(JSON.stringify({ data: [{ id: 'fresh-setup-model' }] }))",
      '    return',
      '  }',
      "  if (req.method === 'POST' && req.url === '/v1/chat/completions') {",
      "    let body = ''",
      "    req.setEncoding('utf8')",
      "    req.on('data', chunk => { body += chunk })",
      "    req.on('end', () => {",
      '      const request = JSON.parse(body)',
      "      const content = body.includes('image_url') ? 'fresh setup vision ready' : 'fresh setup chat ready'",
      '      if (request.stream === true) {',
      "        res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })",
      "        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] }) + '\\n\\ndata: [DONE]\\n\\n')",
      '        return',
      '      }',
      "      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })",
      '      res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 4 } }))',
      '    })',
      '    return',
      '  }',
      '  res.writeHead(404)',
      '  res.end()',
      '})',
      "server.listen(port, '127.0.0.1')",
      "process.on('SIGTERM', () => server.close(() => process.exit(0)))",
      "process.on('SIGINT', () => server.close(() => process.exit(0)))"
    ].join('\n')
  )
  executable(
    path.join(binDir, 'whisper', 'whisper-cli'),
    "#!/bin/sh\nprintf '%s\\n' 'fresh setup transcription ready'\n"
  )
  executable(
    path.join(binDir, 'sd', 'sd-cli'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs')",
      'const args = process.argv.slice(2)',
      "const outputIndex = args.indexOf('-o')",
      'if (outputIndex < 0) process.exit(64)',
      `fs.writeFileSync(args[outputIndex + 1], Buffer.from('${PNG_BASE64}', 'base64'))`
    ].join('\n')
  )
  executable(
    path.join(resourceDir, 'bin', 'executorch-speech'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs')",
      'const args = process.argv.slice(2)',
      "const output = args[args.indexOf('--output') + 1]",
      'if (output) {',
      "  let input = ''",
      "  process.stdin.setEncoding('utf8')",
      "  process.stdin.on('data', chunk => { input += chunk })",
      "  process.stdin.on('end', () => {",
      "    fs.writeFileSync(output, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(60, 1)]))",
      '  })',
      '}'
    ].join('\n')
  )
}

function fixtureBytes(fileName: string, seed: number): Buffer {
  if (/^ggml-[^/\\]+\.bin$/i.test(fileName)) {
    return Buffer.alloc(WHISPER_MIN_BYTES, seed)
  }
  if (fileName.endsWith('.gguf')) {
    return Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2_044, seed)])
  }
  return Buffer.concat([Buffer.from(`off-grid-${fileName}-`), Buffer.alloc(2_048, seed)])
}

function installDownloadBoundary(models: JourneyModel[]): void {
  const metadata = new Map<
    string,
    { revision: string; files: Array<{ name: string; bytes: Buffer }> }
  >()
  models.forEach((model, modelIndex) => {
    model.files.forEach((file, fileIndex) => {
      const bytes = fixtureBytes(file.name, modelIndex * 10 + fileIndex + 1)
      delivery.set(file.url, bytes)
      const source = new URL(file.url)
      const match = /^\/([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/.exec(source.pathname)
      if (!match || source.hostname !== 'huggingface.co') return
      const repo = match[1]!
      const requestedRevision = decodeURIComponent(match[2]!)
      const revision = /^[a-f0-9]{40}$/i.test(requestedRevision)
        ? requestedRevision
        : 'a'.repeat(40)
      const record = metadata.get(repo) ?? { revision, files: [] }
      record.files.push({ name: decodeURIComponent(match[3]!), bytes })
      metadata.set(repo, record)
      delivery.set(`https://huggingface.co/${repo}/resolve/${revision}/${match[3]!}`, bytes)
    })
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const metadataUrl = new URL(url)
      const metadataMatch = /^\/api\/models\/([^/]+\/[^/]+)\/revision\/[^/]+$/.exec(
        metadataUrl.pathname
      )
      if (metadataUrl.hostname === 'huggingface.co' && metadataMatch) {
        const record = metadata.get(metadataMatch[1]!)
        if (!record) return new Response(null, { status: 404 })
        return Response.json({
          sha: record.revision,
          siblings: record.files.map((file) => ({ rfilename: file.name, size: file.bytes.length }))
        })
      }
      const bytes = delivery.get(url)
      if (!bytes) return hostFetch(input, init)
      remoteRequests++

      const range = new Headers(init?.headers).get('range')
      if (range) {
        resumedRanges.set(url, range)
        resumedRanges.set(decodeURIComponent(new URL(url).pathname.split('/').at(-1)!), range)
        const offset = Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? 0)
        const suffix = bytes.subarray(offset)
        return new Response(new Uint8Array(suffix), {
          status: 206,
          headers: { 'content-length': String(suffix.length) }
        })
      }

      if (interruptDownloads && !interrupted.has(url)) {
        interrupted.add(url)
        const prefix = bytes.subarray(0, Math.min(700, bytes.length - 1))
        let pull = 0
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (pull++ === 0) {
              controller.enqueue(prefix)
              return
            }
            controller.error(new Error('network connection interrupted'))
          }
        })
        return new Response(body, {
          status: 200,
          headers: { 'content-length': String(bytes.length) }
        })
      }

      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { 'content-length': String(bytes.length) }
      })
    })
  )
}

/**
 * Wait until the runtime under test has let go of the port IT bound.
 *
 * Take the port from the runtime (llm.getPort()) rather than naming 8439: when 8439 is already busy the
 * app deliberately falls back to a free port, so a hardcoded number can end up watching a port this
 * runtime never owned - which is either a neighbour's live server (fails for the wrong reason) or nothing
 * at all (passes without proving anything). Every dbtest in this suite shares one worker and the same
 * default port, so that is not hypothetical.
 */
async function waitForPortRelease(port: number): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`)
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`runtime boundary still owns port ${port}`)
}

function expectWav(dataUrl: string): void {
  expect(dataUrl).toMatch(/^data:audio\/wav;base64,/)
  expect(Buffer.from(dataUrl.split(',')[1]!, 'base64').subarray(0, 4).toString('ascii')).toBe(
    'RIFF'
  )
}

function findFile(rootDirectory: string, fileName: string): string | undefined {
  for (const entry of fs.readdirSync(rootDirectory, { withFileTypes: true })) {
    const candidate = path.join(rootDirectory, entry.name)
    if (entry.isDirectory()) {
      const nested = findFile(candidate, fileName)
      if (nested) return nested
    } else if (entry.name.endsWith(fileName)) {
      return candidate
    }
  }
  return undefined
}

async function downloadThrough(
  application: OffGridApplication,
  modelId: string
): Promise<{ success: boolean; error?: string }> {
  const outcome = await application.models.control({ type: 'download', modelId })
  return outcome.ok && outcome.value.status === 'completed'
    ? { success: true }
    : outcome.ok
      ? { success: false, error: outcome.value.status }
      : { success: false, error: modelsFailureMessage(outcome.failure) }
}

async function selectThrough(
  application: OffGridApplication,
  surface: 'text' | 'image' | 'speech' | 'transcription',
  modelId: string
): Promise<{ success: boolean; error?: string }> {
  const outcome = await application.models.control({ type: 'select', surface, modelId })
  if (!outcome.ok) return { success: false, error: modelsFailureMessage(outcome.failure) }
  const prepared = await application.models.prepare(surface === 'speech' ? 'voice' : surface)
  return prepared.ok
    ? { success: true }
    : { success: false, error: modelsFailureMessage(prepared.failure) }
}

afterAll(async () => {
  const shutdownFailures: unknown[] = []
  for (const composition of [...startedApplicationCompositions].reverse()) {
    try {
      await stopApplication(composition)
    } catch (error) {
      shutdownFailures.push(error)
    }
  }
  try {
    const { llm } = await import('../llm')
    llm.stop()
  } catch {
    // A failed assertion can happen before the runtime module loads.
  }
  try {
    const database = await import('../database')
    database.getDB().close()
  } catch {
    // The profile may not have reached first TTS use.
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  if (originalBinDir === undefined) delete process.env.OFFGRID_BIN_DIR
  else process.env.OFFGRID_BIN_DIR = originalBinDir
  if (originalResourceDir === undefined) delete process.env.OFFGRID_RESOURCE_DIR
  else process.env.OFFGRID_RESOURCE_DIR = originalResourceDir
  if (originalSkipCompatibleGenerationModel === undefined) {
    delete process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL
  } else {
    process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL = originalSkipCompatibleGenerationModel
  }
  fs.rmSync(root, { recursive: true, force: true })
  if (shutdownFailures.length > 0) {
    throw new AggregateError(shutdownFailures, 'Desktop application shutdown failed')
  }
})

describe('fresh setup to first use', () => {
  it('resumes the full baseline, uses every selected runtime, and stays usable after relaunch', async () => {
    expect(fs.existsSync(dataDir)).toBe(false)
    installRuntimeBoundaries()
    // Electron owns the userData directory before main-process composition begins.
    fs.mkdirSync(dataDir, { recursive: true })

    // Load one production composition graph. Parallel imports immediately after a module reset can
    // instantiate separate copies of singleton-bearing modules in Vitest's module runner, which is
    // not a Desktop relaunch and makes setup inspect a different runtime from the lifecycle adapter.
    const setup = await import('../setup')
    const initialApplication = await import('../composition/application')
    const { llm } = await import('../llm')
    const managerBase = await import('../models-manager')
    const { CATALOG, MODEL_KINDS } = await import('@offgrid/models')
    const manager = managerBase

    // The native settings adapter persists launch facts only. Shared's application
    // command owns any restart after a model exists, so a fresh profile reports the
    // pending launch change without trying to start a missing model.
    await expect(llm.setSettings({ performanceMode: 'conservative' })).resolves.toEqual({
      launchChanged: true
    })
    const plan = await setup.getSetupPlan()
    expect(plan.mode).toBe('conservative')
    expect(plan.items.map((item) => item.kind)).toEqual(['chat', 'transcription', 'voice'])
    expect(plan.items.find((item) => item.kind === 'chat')?.installed).toBe(false)
    expect(plan.items.find((item) => item.kind === 'transcription')?.installed).toBe(false)
    // Desktop bundles the speech runtime, but Shared still owns the voice-model
    // artifact and must report a fresh profile as not installed until it arrives.
    expect(plan.items.find((item) => item.kind === 'voice')?.installed).toBe(false)

    const baselineModels: JourneyModel[] = plan.items.map((item) => {
      const catalogEntry = CATALOG.find((entry) => entry.id === item.id)
      if (!catalogEntry) throw new Error(`Setup selected a model outside the catalog: ${item.id}`)
      if (!isFirstUseModelKind(catalogEntry.kind)) {
        throw new Error(`Setup selected an optional ${catalogEntry.kind} model: ${item.id}`)
      }
      return {
        id: item.id,
        kind: catalogEntry.kind,
        files: catalogEntry.files.map((file) => ({ name: file.name, url: file.url }))
      }
    })
    // Derived from the catalog rather than hardcoded, because a kind the app SUPPORTS is not the same as
    // a kind it SHIPS. 'text' is still a ModelKind - a user can add a text-only GGUF - but no catalog
    // entry is one any more: every shipped chat model is multimodal, so it is kind 'vision' and carries an
    // mmproj beside its weights. Naming 'text' here asked first-use to download a model that does not
    // exist, which is a stale fixture rather than a gap in setup.
    // Computer Use stays an explicit Models-catalog choice. Fresh setup must not add its multi-GB
    // policy package to the baseline that prepares chat, image, transcription, and voice.
    const requiredKinds = MODEL_KINDS.filter(
      (kind): kind is JourneyModel['kind'] =>
        isFirstUseModelKind(kind) && CATALOG.some((entry) => entry.kind === kind)
    )
    expect(requiredKinds).toEqual(
      expect.arrayContaining(['vision', 'image', 'transcription', 'voice'])
    )
    const baselineKinds = new Set(baselineModels.map((model) => model.kind))
    const additionalModels: JourneyModel[] = requiredKinds
      .filter((kind) => !baselineKinds.has(kind))
      .map((kind) => {
        const catalogEntry = CATALOG.find((entry) => entry.kind === kind)
        if (!catalogEntry) throw new Error(`Catalog has no ${kind} model for first use`)
        return {
          id: catalogEntry.id,
          kind,
          files: catalogEntry.files.map((file) => ({ name: file.name, url: file.url }))
        }
      })
    const models = [...baselineModels, ...additionalModels]
    const downloadableModels = models.filter((model) => model.files.length > 0)
    expect(new Set(models.map((model) => model.kind))).toEqual(new Set(requiredKinds))
    installDownloadBoundary(models)
    await startApplication(initialApplication)

    // Each representative modality download loses its connection after writing a
    // real .part prefix. No model is installed or selectable from partial bytes.
    const interruptedFileByModel = new Map<string, CatalogFile>()
    for (const model of downloadableModels) {
      await expect(
        downloadThrough(initialApplication.desktopApplication, model.id)
      ).resolves.toEqual({
        success: false,
        error: 'network connection interrupted'
      })
      const interruptedFile = model.files.find((file) =>
        findFile(path.join(dataDir, 'models'), `${file.name}.part`)
      )
      expect(interruptedFile).toBeDefined()
      interruptedFileByModel.set(model.id, interruptedFile!)
      const partialPath = findFile(path.join(dataDir, 'models'), `${interruptedFile!.name}.part`)
      expect(fs.statSync(partialPath!).size).toBe(700)
      expect(await manager.listInstalled()).not.toContain(model.id)
    }

    // The HTTP boundary serves compact deterministic artifacts. Persist matching
    // manifest evidence before relaunch so the real integrity gate can verify the
    // resumed bytes without allocating the multi-gigabyte production artifacts.
    const downloadsFile = path.join(dataDir, 'models', 'downloads.json')
    const persistedDownloads = JSON.parse(fs.readFileSync(downloadsFile, 'utf8')) as Array<{
      manifest: { artifacts: Array<{ url: string; sizeBytes?: number }> }
    }>
    for (const record of persistedDownloads) {
      for (const artifact of record.manifest.artifacts) {
        artifact.sizeBytes = delivery.get(artifact.url)?.length
      }
    }
    fs.writeFileSync(downloadsFile, JSON.stringify(persistedDownloads))

    // Relaunch the module graph like a newly started main process. The production
    // registry restores every interrupted row. Configure for me resumes its baseline,
    // then the same download owner resumes the remaining catalog modalities.
    await stopApplication(initialApplication)
    vi.resetModules()
    interruptDownloads = false
    // Electron creates this profile directory before it loads the main graph. The module-reset
    // relaunch must reproduce that native boundary instead of asking SQLite to create its parent.
    fs.mkdirSync(dataDir, { recursive: true })
    const resumedApplication = await import('../composition/application')
    const { llm: resumedLlm } = await import('../llm')
    const resumedManagerBase = await import('../models-manager')
    const resumedManager = resumedManagerBase
    await startApplication(resumedApplication)
    expect(resumedApplication.desktopApplication.models.snapshot().downloads).toEqual(
      expect.arrayContaining(
        downloadableModels.map((model) =>
          expect.objectContaining({
            modelId: model.id,
            status: 'failed',
            reason: 'network connection interrupted'
          })
        )
      )
    )

    const progress: import('../setup').SetupProgress[] = []
    const resumedResult = await resumedApplication.desktopApplication.models.guidedSetup.run(
      (event) => progress.push(event)
    )
    expect(resumedResult).toMatchObject({
      success: true,
      status: 'ready'
    })
    expect(resumedResult.modelId).toBe(baselineModels[0]!.id)
    expect(progress.at(-1)).toMatchObject({
      phase: 'done',
      modelId: baselineModels[0]!.id
    })
    for (const model of additionalModels.filter((candidate) => candidate.files.length > 0)) {
      await expect(
        downloadThrough(resumedApplication.desktopApplication, model.id)
      ).resolves.toEqual({
        success: true
      })
      await expect(
        selectThrough(
          resumedApplication.desktopApplication,
          model.kind === 'voice' ? 'speech' : model.kind === 'vision' ? 'text' : model.kind,
          model.id
        )
      ).resolves.toEqual({ success: true })
    }
    expect(await resumedManager.listInstalled()).toEqual(
      expect.arrayContaining(models.map((model) => model.id))
    )
    for (const model of downloadableModels) {
      const interruptedFile = interruptedFileByModel.get(model.id)!
      expect(resumedRanges.get(interruptedFile.name)).toBe('bytes=700-')
      expect(findFile(path.join(dataDir, 'models'), `${interruptedFile.name}.part`)).toBeUndefined()
    }

    // A SECOND chat model, not the one being activated. What the assertion below protects is that
    // activating one chat model as the text modality does not leave another marked active too - so this
    // has to be a different entry from visionModel. It used to be kind 'text'; since every shipped chat
    // model is multimodal now, the second one is simply another 'vision' entry.
    // A text-ONLY model, imported the way a user adds one.
    //
    // The journey needs one to prove that a multimodal model claims the text modality and DISPLACES a
    // text-only model: this one is activated, and by the end 'text' is served by the vision model while
    // this id is no longer active. Nothing in the catalog can play that part any more - every model it
    // ships for chat is multimodal, so it is kind 'vision' with an mmproj beside its weights - and a
    // made-up catalog id cannot either, because downloadModel only knows catalog entries ('unknown
    // model'). importLocalModel is the real path for a text-only GGUF, and it registers exactly kind
    // 'text', so the property is exercised through the API a user actually reaches.
    //
    // A valid GGUF here is its four-byte magic and at least GGUF_MIN_BYTES - see models/gguf.ts, which is
    // all the import checks before copying. Nothing loads these weights; the llama socket is faked.
    const localGgufPath = path.join(dataDir, 'text-only-chat-Q4_K_M.gguf')
    fs.writeFileSync(localGgufPath, Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(4096)]))
    const imported = await resumedManager.importLocalModel(localGgufPath)
    expect(imported, JSON.stringify(imported)).toMatchObject({ success: true })
    const textModel = { id: imported.id!, kind: 'text' as const }
    expect(resumedManager.getLocalModels().map(({ id, kind }) => ({ id, kind }))).toContainEqual({
      id: textModel.id,
      kind: 'text'
    })
    await expect(resumedApplication.desktopApplication.models.refresh()).resolves.toMatchObject({
      ok: true
    })

    const visionModel = models.find((model) => model.kind === 'vision')!
    const imageModel = models.find((model) => model.kind === 'image')!
    const transcriptionModel = models.find((model) => model.kind === 'transcription')!
    const voiceModel = models.find((model) => model.kind === 'voice')!

    const { generateImage } = await import('../imagegen')

    await expect(
      selectThrough(resumedApplication.desktopApplication, 'text', textModel.id)
    ).resolves.toEqual({ success: true })
    expect(await generatedText('Prove the fresh chat model can answer')).toBe(
      'fresh setup chat ready'
    )
    const { getActiveTranscription } = await import('../transcription/select')
    const syntheticAudio = path.join(root, 'synthetic.wav')
    fs.writeFileSync(syntheticAudio, Buffer.from('synthetic audio boundary'))
    await expect(
      getActiveTranscription().transcribe({ path: syntheticAudio }, { alreadyWav16k: true })
    ).resolves.toEqual({ text: 'fresh setup transcription ready', language: undefined })
    const { synthesize } = await import('../tts')
    expectWav((await synthesize('Fresh setup speech is ready')).dataUrl)

    const visionInput = path.join(root, 'vision-input.png')
    fs.writeFileSync(visionInput, Buffer.from(PNG_BASE64, 'base64'))
    await expect(
      selectThrough(resumedApplication.desktopApplication, 'text', visionModel.id)
    ).resolves.toEqual({ success: true })
    expect(resumedLlm.hasVision()).toBe(true)
    await expect(generatedText('Describe this image', [visionInput])).resolves.toBe(
      'fresh setup vision ready'
    )

    await expect(
      selectThrough(resumedApplication.desktopApplication, 'image', imageModel.id)
    ).resolves.toEqual({ success: true })
    const generated = await generateImage({
      prompt: 'A green cabin under stars',
      seed: 314,
      width: 512,
      height: 512,
      steps: 4
    })
    expect(generated.dataUrl).toBe(`data:image/png;base64,${PNG_BASE64}`)
    expect(fs.readFileSync(generated.path).toString('base64')).toBe(PNG_BASE64)

    const active = resumedManager.getActiveModalities()
    expect(active).toEqual({
      text: visionModel.id,
      image: expect.any(String),
      computer_use: null,
      transcription: transcriptionModel.id,
      speech: voiceModel.id
    })
    expect(await resumedManager.getActiveModelIds()).toEqual(
      expect.arrayContaining([visionModel.id, imageModel.id, transcriptionModel.id, voiceModel.id])
    )
    expect(await resumedManager.getActiveModelIds()).not.toContain(textModel.id)

    const requestsAfterFirstUse = remoteRequests
    const resumedPort = resumedLlm.getPort()
    await stopApplication(resumedApplication)
    const database = await import('../database')
    database.getDB().close()
    await waitForPortRelease(resumedPort)

    // A second relaunch must consume the exact persisted install and selections.
    // It must not repair or redownload anything to make first use work again.
    vi.resetModules()
    const relaunchedSetup = await import('../setup')
    const relaunchedApplication = await import('../composition/application')
    const { llm: relaunchedLlm } = await import('../llm')
    const relaunchedManager = await import('../models-manager')
    const relaunchedImage = await import('../imagegen')
    await startApplication(relaunchedApplication)
    const relaunchedPlan = await relaunchedSetup.getSetupPlan()
    expect(relaunchedPlan.items.every((item) => item.installed)).toBe(true)
    expect(relaunchedPlan.totalDownloadGb).toBe(0)
    expect(await relaunchedManager.listInstalled()).toEqual(
      expect.arrayContaining(models.map((model) => model.id))
    )
    expect(relaunchedManager.getActiveModalities()).toEqual(active)
    expect(await relaunchedManager.getActiveModelIds()).toEqual(
      expect.arrayContaining([visionModel.id, imageModel.id, transcriptionModel.id, voiceModel.id])
    )
    await expect(generatedText('Describe this persisted image', [visionInput])).resolves.toBe(
      'fresh setup vision ready'
    )
    await expect(
      selectThrough(relaunchedApplication.desktopApplication, 'text', textModel.id)
    ).resolves.toEqual({ success: true })
    expect(await generatedText('Prove the persisted text model can answer')).toBe(
      'fresh setup chat ready'
    )
    await expect(
      selectThrough(relaunchedApplication.desktopApplication, 'text', visionModel.id)
    ).resolves.toEqual({ success: true })
    const { getActiveTranscription: getRelaunchedTranscription } =
      await import('../transcription/select')
    await expect(
      getRelaunchedTranscription().transcribe({ path: syntheticAudio }, { alreadyWav16k: true })
    ).resolves.toEqual({ text: 'fresh setup transcription ready', language: undefined })
    const { synthesize: synthesizeAfterRelaunch } = await import('../tts')
    expectWav((await synthesizeAfterRelaunch('Persisted speech is ready')).dataUrl)
    const regenerated = await relaunchedImage.generateImage({
      prompt: 'A persisted green cabin under stars',
      seed: 315,
      width: 512,
      height: 512,
      steps: 4
    })
    expect(regenerated.dataUrl).toBe(`data:image/png;base64,${PNG_BASE64}`)
    expect(remoteRequests).toBe(requestsAfterFirstUse)

    const relaunchedPort = relaunchedLlm.getPort()
    await stopApplication(relaunchedApplication)
    await waitForPortRelease(relaunchedPort)
    const relaunchedDatabase = await import('../database')
    relaunchedDatabase.getDB().close()
  }, 30_000)
})
