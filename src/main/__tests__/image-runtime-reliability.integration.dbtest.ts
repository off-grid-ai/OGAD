/**
 * Real multimodal-runtime reliability integration.
 *
 * Production LLMService, imagegen, TTS, ModalityQueue, runtime-manager, SQLite
 * residency, argument building, process lifecycle, and HTTP transports remain real.
 * Only the bundled native executables and reported host RAM are controlled.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createOfflineFetchBoundary, type OfflineFetchBoundary } from './harness/offline-fetch'

const hostFetch = globalThis.fetch.bind(globalThis)

const fixture = (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-image-runtime-'))
  return {
    root,
    dataDir: path.join(root, 'data'),
    binDir: path.join(root, 'bin'),
    resourceDir: path.join(root, 'resources'),
    llamaLog: path.join(root, 'llama-starts.log'),
    imageLog: path.join(root, 'image-runs.log'),
    ttsFailureMarker: path.join(root, 'fail-next-tts'),
    ttsInputLog: path.join(root, 'tts-inputs.log')
  }
})()

vi.mock('electron', () => ({
  app: {
    getPath: () => fixture.dataDir,
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

const CHAT_MODEL = 'chat-runtime-fixture.gguf'
const IMAGE_MODEL = 'image-runtime-fixture.safetensors'
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

let llm: typeof import('../llm').llm
let generateImage: typeof import('../imagegen').generateImage
let synthesize: typeof import('../tts').synthesize
let startModelServer: typeof import('../model-server').startModelServer
let stopModelServer: typeof import('../model-server').stopModelServer
let gatewayPort: number
let offlineNetwork: OfflineFetchBoundary

function executablePath(...parts: string[]): string {
  return path.join(fixture.binDir, ...parts)
}

function installFakeLlamaBoundary(): void {
  const executable = executablePath('llama', 'llama-server')
  fs.mkdirSync(path.dirname(executable), { recursive: true })
  fs.writeFileSync(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs')
const http = require('node:http')
const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1])
fs.appendFileSync(process.env.OFFGRID_TEST_LLAMA_LOG, 'start ' + process.pid + '\\n')
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"status":"ok"}')
    return
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"data":[{"id":"runtime-fixture"}]}')
    return
  }
  if (req.method === 'POST' && req.url === '/test/crash') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('crashing', () => setTimeout(() => process.exit(23), 25))
    return
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"choices":[{"message":{"content":"chat recovered"}}],"usage":{"total_tokens":2}}')
    })
    return
  }
  res.writeHead(404)
  res.end()
})
server.listen(port, '127.0.0.1')
`
  )
  fs.chmodSync(executable, 0o755)
}

function installFakeImageBoundary(): void {
  const executable = executablePath('sd', 'sd-cli')
  fs.mkdirSync(path.dirname(executable), { recursive: true })
  fs.writeFileSync(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const value = (flag) => args[args.indexOf(flag) + 1]
fs.appendFileSync(process.env.OFFGRID_TEST_IMAGE_LOG, 'run\\n')
fs.writeFileSync(value('-o'), Buffer.from('${PNG_BASE64}', 'base64'))
`
  )
  fs.chmodSync(executable, 0o755)
}

function installFakeTtsBoundary(): void {
  fs.mkdirSync(fixture.resourceDir, { recursive: true })
  fs.writeFileSync(
    path.join(fixture.resourceDir, 'tts-worker.mjs'),
    `import fs from 'node:fs'
const [, , command, output] = process.argv
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', () => {
  if (command !== 'speak' || !output) return
  if (fs.existsSync(process.env.OFFGRID_TEST_TTS_FAILURE_MARKER || '')) {
    fs.rmSync(process.env.OFFGRID_TEST_TTS_FAILURE_MARKER, { force: true })
    process.stderr.write('synthetic native TTS failure')
    return
  }
  fs.appendFileSync(process.env.OFFGRID_TEST_TTS_INPUT_LOG, input + '\\n')
  fs.writeFileSync(output, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(60, 1)]))
})
`
  )
}

function createValidGguf(filePath: string): void {
  const bytes = Buffer.alloc(2048)
  bytes.write('GGUF')
  fs.writeFileSync(filePath, bytes)
}

function lineCount(filePath: string): number {
  try {
    return fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/).filter(Boolean).length
  } catch {
    return 0
  }
}

function startedProcessIds(): number[] {
  try {
    return fs
      .readFileSync(fixture.llamaLog, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => Number(line.split(' ')[1]))
      .filter(Number.isInteger)
  } catch {
    return []
  }
}

async function unusedPort(): Promise<number> {
  const probe = http.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  label: string,
  timeout = 8_000
): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function portIsAvailable(port: number): Promise<boolean> {
  const probe = http.createServer()
  return new Promise((resolve) => {
    probe.once('error', () => resolve(false))
    probe.listen(port, '0.0.0.0', () => probe.close(() => resolve(true)))
  })
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

beforeAll(async () => {
  process.env.OFFGRID_DATA_DIR = fixture.dataDir
  process.env.OFFGRID_BIN_DIR = fixture.binDir
  process.env.OFFGRID_RESOURCE_DIR = fixture.resourceDir
  process.env.OFFGRID_TEST_LLAMA_LOG = fixture.llamaLog
  process.env.OFFGRID_TEST_IMAGE_LOG = fixture.imageLog
  process.env.OFFGRID_TEST_TTS_FAILURE_MARKER = fixture.ttsFailureMarker
  process.env.OFFGRID_TEST_TTS_INPUT_LOG = fixture.ttsInputLog

  const modelsDir = path.join(fixture.dataDir, 'models')
  fs.mkdirSync(modelsDir, { recursive: true })
  createValidGguf(path.join(modelsDir, CHAT_MODEL))
  fs.writeFileSync(path.join(modelsDir, IMAGE_MODEL), 'image checkpoint')
  fs.writeFileSync(
    path.join(modelsDir, 'active-model.json'),
    JSON.stringify({ id: 'runtime-fixture', primary: CHAT_MODEL })
  )
  installFakeLlamaBoundary()
  installFakeImageBoundary()
  installFakeTtsBoundary()
  offlineNetwork = createOfflineFetchBoundary(hostFetch)
  vi.stubGlobal('fetch', offlineNetwork.fetch)

  const [
    { llm: productionLlm },
    { generateImage: productionGenerateImage },
    { synthesize: productionSynthesize, ttsRuntime },
    runtimeManager,
    modelServer
  ] = await Promise.all([
    import('../llm'),
    import('../imagegen'),
    import('../tts'),
    import('../runtime-manager'),
    import('../model-server')
  ])
  llm = productionLlm
  generateImage = productionGenerateImage
  synthesize = productionSynthesize
  startModelServer = modelServer.startModelServer
  stopModelServer = modelServer.stopModelServer
  runtimeManager.registerRuntime(llm.runtime)
  runtimeManager.registerRuntime(ttsRuntime)
  await llm.init()
  gatewayPort = await unusedPort()
})

afterAll(async () => {
  const ownedProcessIds = startedProcessIds()
  const runtimePort = llm.getPort()
  stopModelServer()
  llm.stop()
  await waitFor(
    async () => (await portIsAvailable(gatewayPort)) && (await portIsAvailable(runtimePort)),
    'owned model ports to be released'
  )
  await waitFor(
    () => ownedProcessIds.every((pid) => !processIsAlive(pid)),
    'native model processes to exit'
  )
  expect(offlineNetwork.blockedRequests).toEqual(['https://example.invalid/health'])
  vi.unstubAllGlobals()
  delete process.env.OFFGRID_DATA_DIR
  delete process.env.OFFGRID_BIN_DIR
  delete process.env.OFFGRID_RESOURCE_DIR
  delete process.env.OFFGRID_TEST_LLAMA_LOG
  delete process.env.OFFGRID_TEST_IMAGE_LOG
  delete process.env.OFFGRID_TEST_TTS_FAILURE_MARKER
  delete process.env.OFFGRID_TEST_TTS_INPUT_LOG
  fs.rmSync(fixture.root, { recursive: true, force: true })
})

describe('multimodal runtime reliability', () => {
  it('evicts a resident chat runtime for image generation and reloads it for the next chat', async () => {
    expect(await llm.chat('before image')).toBe('chat recovered')
    expect(lineCount(fixture.llamaLog)).toBe(1)

    const image = await generateImage({
      prompt: 'A green cabin under stars',
      model: IMAGE_MODEL,
      seed: 314,
      width: 512,
      height: 512,
      steps: 4
    })
    expect(image.dataUrl).toBe(`data:image/png;base64,${PNG_BASE64}`)

    expect(await llm.chat('after image')).toBe('chat recovered')
    expect(lineCount(fixture.llamaLog)).toBe(2)
  })

  it('refuses an over-budget image before native execution and runs only after explicit override', async () => {
    const imageRunsBefore = lineCount(fixture.imageLog)
    const imagePath = path.join(fixture.dataDir, 'models', IMAGE_MODEL)
    fs.truncateSync(imagePath, 5_000_000_000)
    const totalMemory = vi.spyOn(os, 'totalmem').mockReturnValue(8_000_000_000)

    try {
      await expect(
        generateImage({ prompt: 'This must not execute', model: IMAGE_MODEL })
      ).rejects.toThrow(
        `Not enough memory to run ${IMAGE_MODEL} (~7.0GB resident) on this 8GB machine. Pick a lighter image model`
      )

      expect(lineCount(fixture.imageLog)).toBe(imageRunsBefore)

      const overridden = await generateImage({
        prompt: 'The user explicitly accepted the memory risk',
        model: IMAGE_MODEL,
        allowUnsafeMemoryOverride: true,
        seed: 66,
        width: 512,
        height: 512,
        steps: 4
      })
      expect(overridden).toMatchObject({
        dataUrl: `data:image/png;base64,${PNG_BASE64}`,
        seed: 66,
        model: IMAGE_MODEL
      })
      expect(lineCount(fixture.imageLog)).toBe(imageRunsBefore + 1)
    } finally {
      totalMemory.mockRestore()
      fs.writeFileSync(imagePath, 'safe image checkpoint')
    }

    expect(await llm.chat('after guarded refusal and explicit override')).toBe('chat recovered')
  }, 20_000)

  it('keeps local chat usable when external network reachability is unavailable', async () => {
    await startModelServer(gatewayPort)
    await expect(fetch('https://example.invalid/health')).rejects.toThrow(
      'network unavailable in offline integration fixture: https://example.invalid'
    )

    const response = await fetch(`http://127.0.0.1:${String(gatewayPort)}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'active',
        messages: [{ role: 'user', content: 'Work without internet' }]
      })
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      choices: [{ message: { content: 'chat recovered' } }]
    })
  })

  it('keeps the core product session private across RAG, image generation, vision, and artifacts', async () => {
    const blockedBefore = [...offlineNetwork.blockedRequests]
    const sourcePath = path.join(fixture.dataDir, 'private-session.md')
    fs.writeFileSync(
      sourcePath,
      'LOCAL_SESSION_AURORA records the release decision without using a remote service.'
    )

    const [{ RagService }, ragStore, { desktopExtraction }] = await Promise.all([
      import('@offgrid/rag'),
      import('../rag/store'),
      import('../rag/extractors')
    ])
    ragStore.createProject({ id: 'offline-session', name: 'Offline session' })
    ragStore.updateProject('offline-session', { includeMemory: false })
    const localRag = new RagService({
      store: ragStore.desktopVectorStore,
      embeddings: {
        dimension: 1,
        async embed(text: string) {
          return [Number(text.toLowerCase().includes('local_session_aurora'))]
        }
      },
      extraction: desktopExtraction
    })
    await localRag.indexDocument({
      projectId: 'offline-session',
      path: sourcePath,
      fileName: path.basename(sourcePath),
      size: fs.statSync(sourcePath).size
    })
    const retrieval = await localRag.searchProject(
      'offline-session',
      'What does LOCAL_SESSION_AURORA record?'
    )
    expect(retrieval.chunks).toEqual([
      expect.objectContaining({
        name: 'private-session.md',
        content: expect.stringContaining('LOCAL_SESSION_AURORA')
      })
    ])
    expect(await llm.chat(localRag.formatForPrompt(retrieval))).toBe('chat recovered')

    const image = await generateImage({
      prompt: 'An emerald privacy diagram',
      model: IMAGE_MODEL,
      seed: 404,
      width: 512,
      height: 512,
      steps: 4
    })
    const modelDir = path.join(fixture.dataDir, 'models')
    fs.writeFileSync(path.join(modelDir, 'mmproj.gguf'), 'gguf')
    fs.writeFileSync(
      path.join(modelDir, 'active-model.json'),
      JSON.stringify({ id: 'runtime-fixture', primary: CHAT_MODEL, mmproj: 'mmproj.gguf' })
    )
    expect(await llm.chat('Describe the private diagram.', [image.path])).toBe('chat recovered')

    const artifacts = await import('../artifacts')
    const saved = artifacts.saveArtifact({
      kind: 'text',
      code: 'LOCAL_SESSION_AURORA evidence',
      title: 'Offline evidence',
      conversationId: 'offline-session-chat',
      projectId: 'offline-session'
    })
    expect(artifacts.listArtifacts({ projectId: 'offline-session' })).toEqual([saved])
    expect(offlineNetwork.blockedRequests).toEqual(blockedBefore)
  }, 20_000)

  it('coalesces concurrent cold starts into one native model process', async () => {
    const startsBefore = lineCount(fixture.llamaLog)
    llm.stop()

    await Promise.all(Array.from({ length: 12 }, () => llm.init()))

    expect(llm.isReady()).toBe(true)
    expect(lineCount(fixture.llamaLog) - startsBefore).toBe(1)
    await startModelServer(gatewayPort)
    const health = await fetch(`http://127.0.0.1:${String(gatewayPort)}/v1`)
    expect(health.status).toBe(200)
  })

  it('recovers chat and TTS after native runtime failures', async () => {
    const initialAnswer = await llm.chat('Give me a reply that can be spoken')
    expect(initialAnswer).toBe('chat recovered')

    const startsBefore = lineCount(fixture.llamaLog)
    const crash = await fetch(`http://127.0.0.1:${String(llm.getPort())}/test/crash`, {
      method: 'POST'
    })
    expect(crash.status).toBe(200)

    await waitFor(() => !llm.isReady(), 'the crashed engine to be marked down')

    fs.writeFileSync(fixture.ttsFailureMarker, 'fail once')
    await expect(synthesize(initialAnswer)).rejects.toThrow('synthetic native TTS failure')
    const retriedSpeech = await synthesize(initialAnswer)
    expect(retriedSpeech.dataUrl).toMatch(/^data:audio\/wav;base64,/)
    expect(
      Buffer.from(retriedSpeech.dataUrl.split(',')[1]!, 'base64').subarray(0, 4).toString('ascii')
    ).toBe('RIFF')

    const responsePromise = fetch(`http://127.0.0.1:${String(gatewayPort)}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'active',
        messages: [{ role: 'user', content: 'Reply after restart' }]
      })
    })
    await waitFor(
      () => lineCount(fixture.llamaLog) > startsBefore && llm.isReady(),
      'the local model engine to recover'
    )
    expect(lineCount(fixture.llamaLog) - startsBefore).toBe(1)

    const response = await responsePromise
    expect(response.status).toBe(200)
    const recovered = (await response.json()) as {
      choices: Array<{ message: { content: string } }>
    }
    expect(recovered).toMatchObject({
      choices: [{ message: { content: 'chat recovered' } }]
    })
    const recoveredSpeech = await synthesize(recovered.choices[0]!.message.content)
    expect(recoveredSpeech.dataUrl).toMatch(/^data:audio\/wav;base64,/)
    expect(fs.readFileSync(fixture.ttsInputLog, 'utf8').trim().split(/\r?\n/)).toEqual([
      'chat recovered',
      'chat recovered'
    ])
  }, 10_000)

  it('persists, scopes, exports, reopens, and fully deletes a generated image artifact', async () => {
    const image = await generateImage({
      prompt: 'An emerald release map',
      model: IMAGE_MODEL,
      seed: 405,
      width: 512,
      height: 512,
      steps: 4
    })
    const imageBytes = Buffer.from(PNG_BASE64, 'base64')
    const exportPath = path.join(fixture.root, 'exports', 'release-map.png')
    fs.mkdirSync(path.dirname(exportPath), { recursive: true })
    fs.writeFileSync(exportPath, 'older export that must only be replaced after a complete copy')

    const imageLibrary = await import('../imagegen')
    const artifacts = await import('../artifacts')
    imageLibrary.saveGeneratedImageScope(image.path, {
      conversationId: 'image-release-chat',
      projectId: 'image-release-project'
    })
    const savedArtifact = artifacts.saveArtifact({
      kind: 'image',
      code: image.path,
      title: 'Emerald release map',
      conversationId: 'image-release-chat',
      projectId: 'image-release-project'
    })

    expect(imageLibrary.listGeneratedImages({ conversationId: 'image-release-chat' })).toEqual([
      expect.objectContaining({
        path: image.path,
        conversationId: 'image-release-chat',
        projectId: 'image-release-project'
      })
    ])
    expect(imageLibrary.listGeneratedImages({ projectId: 'another-project' })).toEqual([])
    expect(artifacts.listArtifacts({ projectId: 'image-release-project' })).toEqual([savedArtifact])

    await imageLibrary.exportGeneratedImage(image.path, exportPath)
    expect(fs.readFileSync(exportPath)).toEqual(imageBytes)
    await expect(
      imageLibrary.exportGeneratedImage(path.join(fixture.root, 'private-notes.txt'), exportPath)
    ).rejects.toThrow('Generated image is outside the app image library.')

    vi.resetModules()
    const reopenedImages = await import('../imagegen')
    const reopenedArtifacts = await import('../artifacts')
    expect(reopenedImages.listGeneratedImages({ projectId: 'image-release-project' })).toEqual([
      expect.objectContaining({ path: image.path, conversationId: 'image-release-chat' })
    ])
    expect(reopenedArtifacts.listArtifacts({ conversationId: 'image-release-chat' })).toEqual([
      expect.objectContaining({ id: savedArtifact.id, kind: 'image', code: image.path })
    ])

    expect(reopenedArtifacts.deleteArtifact(savedArtifact.id)).toBe(true)
    expect(reopenedImages.deleteGeneratedImage(image.path)).toBe(true)
    expect(fs.existsSync(image.path)).toBe(false)
    expect(fs.existsSync(`${image.path}.json`)).toBe(false)
    expect(reopenedImages.listGeneratedImages({ projectId: 'image-release-project' })).toEqual([])
    expect(reopenedArtifacts.listArtifacts({ projectId: 'image-release-project' })).toEqual([])
    expect(fs.readFileSync(exportPath)).toEqual(imageBytes)
  }, 20_000)
})
