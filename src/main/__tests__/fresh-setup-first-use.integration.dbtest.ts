/**
 * Fresh-install release journey through the production setup planner, catalog,
 * model manager, persisted selections, and every supported modality runtime.
 *
 * Only boundaries outside Off Grid are controlled: HTTP serves deterministic
 * model bytes and tiny executables stand in for llama.cpp, stable-diffusion.cpp,
 * whisper.cpp, and Kokoro. The interrupted-download registry, Range resume,
 * filesystem promotion, generic activation, runtime selection, first use, and
 * relaunch behavior stay real.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const originalDataDir = process.env.OFFGRID_DATA_DIR
const originalBinDir = process.env.OFFGRID_BIN_DIR
const originalResourceDir = process.env.OFFGRID_RESOURCE_DIR
const hostFetch = globalThis.fetch.bind(globalThis)
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-fresh-setup-'))
const dataDir = path.join(root, 'profile')
const binDir = path.join(root, 'bin')
const resourceDir = path.join(root, 'resources')
process.env.OFFGRID_DATA_DIR = dataDir
process.env.OFFGRID_BIN_DIR = binDir
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

interface CatalogFile {
  name: string
  url: string
}

interface JourneyModel {
  id: string
  kind: 'text' | 'vision' | 'image' | 'transcription' | 'voice'
  files: CatalogFile[]
}

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const delivery = new Map<string, Buffer>()
const interrupted = new Set<string>()
const resumedRanges = new Map<string, string>()
let interruptDownloads = true
let remoteRequests = 0

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
      '      JSON.parse(body)',
      "      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })",
      "      const content = body.includes('image_url') ? 'fresh setup vision ready' : 'fresh setup chat ready'",
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
      "    fs.writeFileSync(output, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(60, 1)]))",
      '  })',
      '}'
    ].join('\n'),
    { mode: 0o755 }
  )
}

function fixtureBytes(fileName: string, seed: number): Buffer {
  if (fileName.endsWith('.gguf')) {
    return Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2_044, seed)])
  }
  return Buffer.concat([Buffer.from(`off-grid-${fileName}-`), Buffer.alloc(2_048, seed)])
}

function installDownloadBoundary(models: JourneyModel[]): void {
  models.forEach((model, modelIndex) => {
    model.files.forEach((file, fileIndex) => {
      delivery.set(file.url, fixtureBytes(file.name, modelIndex * 10 + fileIndex + 1))
    })
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const bytes = delivery.get(url)
      if (!bytes) return hostFetch(input, init)
      remoteRequests++

      const range = new Headers(init?.headers).get('range')
      if (range) {
        resumedRanges.set(url, range)
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

afterAll(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
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
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  if (originalBinDir === undefined) delete process.env.OFFGRID_BIN_DIR
  else process.env.OFFGRID_BIN_DIR = originalBinDir
  if (originalResourceDir === undefined) delete process.env.OFFGRID_RESOURCE_DIR
  else process.env.OFFGRID_RESOURCE_DIR = originalResourceDir
  fs.rmSync(root, { recursive: true, force: true })
})

describe('fresh setup to first use', () => {
  it('resumes the full baseline, uses every selected runtime, and stays usable after relaunch', async () => {
    expect(fs.existsSync(dataDir)).toBe(false)
    installRuntimeBoundaries()

    const [{ llm }, setup, manager, { CATALOG, MODEL_KINDS }] = await Promise.all([
      import('../llm'),
      import('../setup'),
      import('../models-manager'),
      import('@offgrid/models')
    ])

    // This is the real settings owner. Fresh setup cannot start the model yet, but
    // the selected mode is persisted before that expected missing-model failure.
    await expect(llm.setSettings({ performanceMode: 'conservative' })).rejects.toThrow(
      'Models not downloaded'
    )
    const plan = await setup.getSetupPlan()
    expect(plan.mode).toBe('conservative')
    expect(plan.items.map((item) => item.kind)).toEqual(['chat', 'transcription', 'voice'])
    expect(plan.items.every((item) => item.installed === false)).toBe(true)

    const baselineModels: JourneyModel[] = plan.items.map((item) => {
      const catalogEntry = CATALOG.find((entry) => entry.id === item.id)
      if (!catalogEntry) throw new Error(`Setup selected a model outside the catalog: ${item.id}`)
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
    const requiredKinds: JourneyModel['kind'][] = MODEL_KINDS.filter((kind) =>
      CATALOG.some((entry) => entry.kind === kind)
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
    expect(new Set(models.map((model) => model.kind))).toEqual(new Set(requiredKinds))
    installDownloadBoundary(models)

    // Each representative modality download loses its connection after writing a
    // real .part prefix. No model is installed or selectable from partial bytes.
    for (const model of models) {
      await expect(manager.downloadModel(model.id)).resolves.toEqual({
        success: false,
        error: 'network connection interrupted'
      })
      const firstFile = model.files[0]!
      expect(fs.statSync(path.join(dataDir, 'models', `${firstFile.name}.part`)).size).toBe(700)
      expect(await manager.listInstalled()).not.toContain(model.id)
    }

    // Relaunch the module graph like a newly started main process. The production
    // registry restores every interrupted row. Configure for me resumes its baseline,
    // then the same download owner resumes the remaining catalog modalities.
    vi.resetModules()
    interruptDownloads = false
    const [{ llm: resumedLlm }, resumedSetup, resumedManager] = await Promise.all([
      import('../llm'),
      import('../setup'),
      import('../models-manager')
    ])
    expect(resumedManager.listDownloads()).toEqual(
      expect.arrayContaining(
        models.map((model) =>
          expect.objectContaining({
            modelId: model.id,
            status: 'failed',
            error: 'network connection interrupted'
          })
        )
      )
    )

    const progress: import('../setup').SetupProgress[] = []
    await expect(
      resumedSetup.autoConfigure((event) => progress.push(event))
    ).resolves.toMatchObject({ success: true, modelId: baselineModels[0]!.id })
    expect(progress.at(-1)).toMatchObject({
      phase: 'done',
      modelId: baselineModels[0]!.id
    })
    for (const model of additionalModels) {
      await expect(resumedManager.retryDownload(model.id)).resolves.toEqual({ success: true })
      await expect(resumedManager.activateModel(model.id)).resolves.toEqual({ success: true })
    }
    expect(await resumedManager.listInstalled()).toEqual(
      expect.arrayContaining(models.map((model) => model.id))
    )
    for (const model of models) {
      const firstFile = model.files[0]!
      expect(resumedRanges.get(firstFile.url)).toBe('bytes=700-')
      expect(fs.existsSync(path.join(dataDir, 'models', `${firstFile.name}.part`))).toBe(false)
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
    const imported = await manager.importLocalModel(localGgufPath)
    expect(imported).toMatchObject({ success: true })
    const textModel = { id: imported.id!, kind: 'text' as const }
    expect(manager.getLocalModels().map(({ id, kind }) => ({ id, kind }))).toContainEqual({
      id: textModel.id,
      kind: 'text'
    })

    const visionModel = models.find((model) => model.kind === 'vision')!
    const imageModel = models.find((model) => model.kind === 'image')!
    const transcriptionModel = models.find((model) => model.kind === 'transcription')!
    const voiceModel = models.find((model) => model.kind === 'voice')!

    const { registerRuntime } = await import('../runtime-manager')
    const { generateImage, imageRuntime } = await import('../imagegen')
    const { ttsRuntime } = await import('../tts')
    const { sttRuntime } = await import('../transcription/select')
    registerRuntime(resumedLlm.runtime)
    registerRuntime(imageRuntime)
    registerRuntime(sttRuntime)
    registerRuntime(ttsRuntime)

    await expect(resumedManager.activateModel(textModel.id)).resolves.toEqual({ success: true })
    expect(await resumedLlm.chat('Prove the fresh chat model can answer')).toBe(
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
    await expect(resumedManager.activateModel(visionModel.id)).resolves.toEqual({ success: true })
    expect(resumedLlm.hasVision()).toBe(true)
    await expect(resumedLlm.chat('Describe this image', [visionInput])).resolves.toBe(
      'fresh setup vision ready'
    )

    await expect(resumedManager.activateModel(imageModel.id)).resolves.toEqual({ success: true })
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
      transcription: transcriptionModel.id,
      speech: voiceModel.id
    })
    expect(await resumedManager.getActiveModelIds()).toEqual(
      expect.arrayContaining([visionModel.id, imageModel.id, transcriptionModel.id, voiceModel.id])
    )
    expect(await resumedManager.getActiveModelIds()).not.toContain(textModel.id)

    const requestsAfterFirstUse = remoteRequests
    const resumedPort = resumedLlm.getPort()
    resumedLlm.stop()
    const database = await import('../database')
    database.getDB().close()
    await waitForPortRelease(resumedPort)

    // A second relaunch must consume the exact persisted install and selections.
    // It must not repair or redownload anything to make first use work again.
    vi.resetModules()
    const [
      { llm: relaunchedLlm },
      relaunchedSetup,
      relaunchedManager,
      relaunchedRuntimeManager,
      relaunchedImage,
      relaunchedTts,
      relaunchedTranscription
    ] = await Promise.all([
      import('../llm'),
      import('../setup'),
      import('../models-manager'),
      import('../runtime-manager'),
      import('../imagegen'),
      import('../tts'),
      import('../transcription/select')
    ])
    relaunchedRuntimeManager.registerRuntime(relaunchedLlm.runtime)
    relaunchedRuntimeManager.registerRuntime(relaunchedImage.imageRuntime)
    relaunchedRuntimeManager.registerRuntime(relaunchedTranscription.sttRuntime)
    relaunchedRuntimeManager.registerRuntime(relaunchedTts.ttsRuntime)
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
    await expect(relaunchedLlm.chat('Describe this persisted image', [visionInput])).resolves.toBe(
      'fresh setup vision ready'
    )
    await expect(relaunchedManager.activateModel(textModel.id)).resolves.toEqual({ success: true })
    expect(await relaunchedLlm.chat('Prove the persisted text model can answer')).toBe(
      'fresh setup chat ready'
    )
    await expect(relaunchedManager.activateModel(visionModel.id)).resolves.toEqual({
      success: true
    })
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
    relaunchedLlm.stop()
    await waitForPortRelease(relaunchedPort)
    const relaunchedDatabase = await import('../database')
    relaunchedDatabase.getDB().close()
  }, 30_000)
})
