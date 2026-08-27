/**
 * Local real-engine acceptance for the Voice journey. A real recorded WAV enters through the
 * Voice screen's file-drop caller, reaches bundled ffmpeg + Whisper, then the resulting transcript
 * is sent through the production Kokoro TTS API and must return a playable WAV.
 *
 * The profile is always temporary. Only the required model files are symlinked into it, so this
 * test cannot read or mutate the user's conversations, settings, or database.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchOffGrid } from './helpers/launch'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const FIXTURE = path.resolve('e2e/fixtures/hey-how-are-you-doing.wav')
const REAL_MODELS = path.join(
  os.homedir(),
  'Library/Application Support/Off Grid AI Desktop/models'
)
const WHISPER_MODEL = 'ggml-tiny.bin'
const KOKORO_MODEL = 'kokoro-82m-v1.0.onnx'
const KOKORO_CACHE = path.join('.cache', 'kokoro')

const requiredPaths = [
  FIXTURE,
  path.join(REAL_MODELS, WHISPER_MODEL),
  path.join(REAL_MODELS, KOKORO_MODEL),
  path.join(REAL_MODELS, KOKORO_CACHE),
  path.resolve('resources/bin/ffmpeg'),
  path.resolve('resources/bin/whisper/whisper-cli'),
  path.resolve('resources/tts-worker.mjs')
]

interface VoiceRecording {
  id: number
  source: 'dictation' | 'file'
  transcript: string | null
  status: 'transcribing' | 'done' | 'error'
  error: string | null
}

let app: ElectronApplication
let page: Page
let profile: string
let importedTranscript = ''

function assertDisposableProfile(candidate: string): void {
  const resolved = path.resolve(candidate)
  const basename = path.basename(resolved)
  if (!basename.startsWith('offgrid-') || resolved === path.parse(resolved).root) {
    throw new Error(`Refusing to reset non-disposable E2E profile: ${resolved}`)
  }
}

async function finishOnboarding(): Promise<void> {
  for (let step = 0; step < 8; step += 1) {
    const button = page.getByRole('button', { name: /Continue|Start using Off Grid AI/i })
    if (!(await button.isVisible().catch(() => false))) return
    await button.click()
    await page.waitForTimeout(250)
  }
}

async function recordings(): Promise<VoiceRecording[]> {
  return page.evaluate(async () => {
    return (await window.api.proInvoke('voice:recordings:list', 50)) as VoiceRecording[]
  })
}

async function waitForRecording(
  source: VoiceRecording['source'],
  afterId = 0
): Promise<VoiceRecording> {
  let found: VoiceRecording | undefined
  await expect
    .poll(
      async () => {
        found = (await recordings()).find((row) => row.source === source && row.id > afterId)
        return found?.status ?? 'missing'
      },
      { timeout: 120_000 }
    )
    .toBe('done')
  if (!found) throw new Error(`No completed ${source} recording found`)
  return found
}

function expectFixturePhrase(transcript: string | null): void {
  const normalized = (transcript ?? '').toLowerCase()
  expect(normalized).toMatch(/hey|how/)
  expect(normalized).toMatch(/you/)
  expect(normalized).toMatch(/doing/)
}

test.describe.configure({ mode: 'serial', timeout: 180_000 })

test.beforeAll(async () => {
  test.skip(
    requiredPaths.some((required) => !fs.existsSync(required)),
    'real local Whisper/Kokoro engines and models are required'
  )

  profile = process.env.OFFGRID_E2E_PROFILE
    ? path.resolve(process.env.OFFGRID_E2E_PROFILE)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-voice-real-'))
  assertDisposableProfile(profile)
  fs.rmSync(profile, { recursive: true, force: true })
  const modelDir = path.join(profile, 'models')
  fs.mkdirSync(path.join(modelDir, '.cache'), { recursive: true })
  fs.symlinkSync(path.join(REAL_MODELS, WHISPER_MODEL), path.join(modelDir, WHISPER_MODEL))
  fs.symlinkSync(path.join(REAL_MODELS, KOKORO_MODEL), path.join(modelDir, KOKORO_MODEL))
  fs.symlinkSync(path.join(REAL_MODELS, KOKORO_CACHE), path.join(modelDir, KOKORO_CACHE))
  fs.writeFileSync(
    path.join(modelDir, 'active-modalities.json'),
    JSON.stringify({ transcription: WHISPER_MODEL, speech: 'kokoro' })
  )

  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profile,
      OFFGRID_PRO: '1',
      OFFGRID_SEED: 'force',
      OFFGRID_SEED_PRO: 'force',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await finishOnboarding()
  await page.getByRole('button', { name: 'Voice', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Voice', exact: true })).toBeVisible()
  await page.evaluate(async () => {
    await window.api.proInvoke('voice:dictation:set-settings', {
      mode: 'toggle',
      paste: false,
      ingest: false,
      language: 'en',
      sttEngine: 'whisper'
    })
  })
})

test.afterAll(async () => {
  await app?.close()
  if (profile && !process.env.OFFGRID_E2E_PROFILE) {
    fs.rmSync(profile, { recursive: true, force: true })
  }
})

test('recorded WAV drop reaches the real Voice file-transcription caller', async () => {
  const before = await recordings()
  const lastId = Math.max(0, ...before.map((row) => row.id))
  const bytes = fs.readFileSync(FIXTURE).toString('base64')
  await page.getByLabel('Voice recordings').evaluate((element, base64) => {
    const raw = atob(base64)
    const data = new Uint8Array(raw.length)
    for (let index = 0; index < raw.length; index += 1) data[index] = raw.charCodeAt(index)
    const transfer = new DataTransfer()
    transfer.items.add(new File([data], 'hey-how-are-you-doing.wav', { type: 'audio/wav' }))
    element.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
    )
  }, bytes)

  const result = await waitForRecording('file', lastId)
  expect(result.error).toBeNull()
  expectFixturePhrase(result.transcript)
  importedTranscript = result.transcript ?? ''
  await expect(page.getByText(/Hey,? how are you doing/i).first()).toBeVisible()
})

test('the real Whisper transcript reaches the real Kokoro TTS service and returns playable WAV', async () => {
  expectFixturePhrase(importedTranscript)
  const wav = await page.evaluate(async (text) => {
    const result = await window.api.speak(text)
    const encoded = result.dataUrl.split(',')[1] ?? ''
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
    return { size: bytes.length, header: String.fromCharCode(...bytes.slice(0, 4)) }
  }, importedTranscript)

  expect(wav.header).toBe('RIFF')
  expect(wav.size).toBeGreaterThan(44)
})
