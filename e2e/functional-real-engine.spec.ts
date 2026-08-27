/**
 * FULL functional sanity against the REAL bundled engines + REAL local models. This is the
 * "does it actually work" smoke: real llama-server generates chat, real kokoro synthesizes
 * speech, real whisper transcribes it back, real sd generates an image. No fakes.
 *
 * Local-only by design: it needs the real model files (~/Library/Application Support/Off Grid AI
 * AI Desktop/models) and the real engine binaries (resources/bin). It SKIPS anywhere those are
 * absent (CI, a fresh checkout) so it never turns the suite red where the models can't exist.
 * Profile stays synthetic (seeded temp dir); only the model files are the real, shared ones.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchOffGrid } from './helpers/launch'
import os from 'os'
import path from 'path'
import fs from 'fs'

const REAL_MODELS = path.join(
  os.homedir(),
  'Library/Application Support/Off Grid AI Desktop/models'
)
const CHAT_MODEL = 'gemma-4-E2B-it-Q4_K_M.gguf'
const CHAT_MMPROJ = 'mmproj-gemma-4-E2B-it-F16.gguf'
const IMAGE_MODEL = 'dreamshaper-xl-v2-turbo-Q8_0.gguf' // turbo = fewer steps, faster smoke
const WHISPER_MODEL = 'ggml-tiny.bin'
const KOKORO_MODEL = 'kokoro-82m-v1.0.onnx'
const BORROWED_MODEL_PATHS = [
  CHAT_MODEL,
  CHAT_MMPROJ,
  IMAGE_MODEL,
  WHISPER_MODEL,
  KOKORO_MODEL,
  path.join('.cache', 'kokoro')
]

const HAVE_ENGINES =
  BORROWED_MODEL_PATHS.every((modelPath) => fs.existsSync(path.join(REAL_MODELS, modelPath))) &&
  fs.existsSync(path.resolve('resources/bin/llama/llama-server')) &&
  fs.existsSync(path.resolve('resources/bin/whisper/whisper-cli')) &&
  fs.existsSync(path.resolve('resources/bin/sd/sd-cli'))

let app: ElectronApplication
let page: Page
let userDataDir: string

test.describe.configure({ mode: 'serial', timeout: 180_000 }) // real model loads are slow

test.beforeAll(async () => {
  test.skip(!HAVE_ENGINES, 'real models/engine binaries not present — local-only functional smoke')
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-real-'))
  // Borrow immutable model blobs one by one. Never symlink the models directory itself:
  // this test writes active-model.json, and a directory symlink would overwrite the user's
  // real model selection instead of keeping all settings inside this disposable profile.
  const modelDir = path.join(userDataDir, 'models')
  fs.mkdirSync(path.join(modelDir, '.cache'), { recursive: true })
  for (const modelPath of BORROWED_MODEL_PATHS) {
    const source = path.join(REAL_MODELS, modelPath)
    const destination = path.join(modelDir, modelPath)
    if (fs.statSync(source).isDirectory()) fs.symlinkSync(source, destination)
    else fs.linkSync(source, destination)
  }
  fs.writeFileSync(
    path.join(modelDir, 'active-model.json'),
    JSON.stringify({ id: 'gemma-e2b-real', primary: CHAT_MODEL, mmproj: CHAT_MMPROJ })
  )
  fs.writeFileSync(
    path.join(modelDir, 'active-modalities.json'),
    JSON.stringify({ transcription: WHISPER_MODEL, speech: 'kokoro', image: IMAGE_MODEL })
  )
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_PRO: '1',
      OFFGRID_SEED: 'force',
      OFFGRID_SEED_PRO: 'force',
      OFFGRID_BIN_DIR: path.resolve('resources/bin'),
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  for (let i = 0; i < 8; i++) {
    const btn = page.getByRole('button', { name: /Continue|Start using Off Grid AI/i })
    if (!(await btn.isVisible().catch(() => false))) break
    await btn.click().catch(() => {})
    await page.waitForTimeout(300)
  }
  await page.waitForTimeout(1000)
})

test.afterAll(async () => {
  await app?.close()
  try {
    // Only remove the temp profile; the symlink target (real models) is left untouched.
    fs.rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

test('chat: real llama-server generates a non-empty streamed reply', async () => {
  // Drive the real renderer -> ragChat IPC -> LLMService -> llama-server path and wait for a
  // real, non-empty assistant reply (first token can be slow while the model loads).
  const reply = await page.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, (...a: unknown[]) => unknown> }).api
    // rag:chat is positional: (query, appName, history, projectId, conversationId, noMemory,
    // streamId, thinking, images). Await the final RagChatResultContract { answer }.
    const result = (await api.ragChat(
      'Reply with a short friendly greeting, one sentence.',
      undefined,
      [],
      null,
      undefined,
      true,
      undefined,
      false
    )) as { answer: string }
    return result.answer ?? ''
  })
  expect(reply.trim().length).toBeGreaterThan(0)
  expect(reply).not.toMatch(/something went wrong/i)
})

test('TTS -> STT round-trip: real kokoro synthesizes, real whisper transcribes it back', async () => {
  const PHRASE = 'the quick brown fox jumps over the lazy dog'
  const transcript = await page.evaluate(async (phrase) => {
    const api = (window as unknown as { api: Record<string, (...a: unknown[]) => unknown> }).api
    const spoken = (await api.speak(phrase)) as { dataUrl: string }
    // Decode the WAV data URL to bytes and hand them straight to the transcription engine
    // (no mic needed — whisper transcribes the buffer).
    const b64 = spoken.dataUrl.split(',')[1] ?? ''
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return (await api.transcribeAudio(bytes, 'wav')) as string
  }, PHRASE)
  expect(transcript.trim().length).toBeGreaterThan(3)
  // whisper-tiny on clean TTS should recover the distinctive content words.
  expect(transcript.toLowerCase()).toMatch(/fox|quick|brown|lazy|dog|jump/)
})

test('image: real sd generates an image for a simple prompt', async () => {
  const result = await page.evaluate(async (modelId) => {
    const api = (window as unknown as { api: Record<string, (...a: unknown[]) => unknown> }).api
    await api.setActiveModalModel('image', modelId)
    const status = (await api.imageGenStatus()) as {
      available: boolean
      reason?: string
      models: string[]
    }
    if (!status.available) return { status }
    return (await api.generateImage({
      prompt: 'a simple red circle on a white background',
      conversationId: null,
      projectId: null
    })) as { imagePath?: string; dataUrl?: string; error?: string }
  }, IMAGE_MODEL)
  expect(
    (result as { status?: { available: boolean; reason?: string; models: string[] } }).status,
    `image runtime unavailable: ${JSON.stringify(result)}`
  ).toBeUndefined()
  expect((result as { error?: string }).error).toBeFalsy()
  const produced = result as { imagePath?: string; dataUrl?: string }
  expect(Boolean(produced.imagePath || produced.dataUrl)).toBe(true)
  if (produced.imagePath) {
    expect(fs.existsSync(produced.imagePath)).toBe(true)
  }
})
