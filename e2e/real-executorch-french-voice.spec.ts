/**
 * A non-English voice speaks through ExecuTorch: a French reply in the French Kokoro voice is
 * logged as ExecuTorch speech, returns playable WAV audio, and whisper hears the words back.
 *
 * No fakes: the ExecuTorch speech runtime (../executorch-speech or resources/bin), its French
 * voice assets, and whisper. Local only. It skips unless those are installed; the temp profile
 * borrows the model files and the voice cache.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import { completeOnboarding } from './helpers/onboarding'
import { closeAndWait } from './helpers/windows'

const REAL_MODELS = path.join(
  os.homedir(),
  'Library/Application Support/Off Grid AI Desktop/models'
)
const VOICE_CACHE = path.join(REAL_MODELS, '.cache', 'executorch-speech')
const WHISPER = 'ggml-base.bin'
const RUNTIME = [
  path.resolve('resources/bin/executorch-speech'),
  path.resolve('../executorch-speech/native/bin/executorch-speech')
].find((candidate) => fs.existsSync(candidate))
const HAVE_FRENCH = fs.existsSync(VOICE_CACHE)
  ? fs.readdirSync(VOICE_CACHE).some((file) => file.includes('ff_siwis'))
  : false

let app: ElectronApplication | null = null
let page: Page
let profileDir: string

test.describe('ExecuTorch voices', () => {
  test.skip(targetIsPackaged(), 'Runs against the source build.')
  test.skip(
    !RUNTIME || !HAVE_FRENCH || !fs.existsSync(path.join(REAL_MODELS, WHISPER)),
    'needs the ExecuTorch speech runtime, the French voice and whisper base'
  )

  test.beforeEach(async () => {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-french-voice-'))
    const models = path.join(profileDir, 'models')
    fs.mkdirSync(path.join(models, '.cache'), { recursive: true })
    fs.symlinkSync(VOICE_CACHE, path.join(models, '.cache', 'executorch-speech'), 'dir')
    fs.linkSync(path.join(REAL_MODELS, WHISPER), path.join(models, WHISPER))
    fs.writeFileSync(
      path.join(models, 'active-modalities.json'),
      JSON.stringify({ transcription: WHISPER })
    )
    app = await launchOffGrid({
      env: {
        ...process.env,
        OFFGRID_USER_DATA: profileDir,
        OFFGRID_BIN_DIR: path.resolve('resources/bin'),
        OFFGRID_NO_SERVICES: '1',
        NODE_ENV: 'production'
      }
    })
    page = await app.firstWindow()
    await completeOnboarding(page)
  })

  test.afterEach(async () => {
    if (app) await closeAndWait(app)
    app = null
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true })
  })

  test('the French voice speaks through ExecuTorch, and whisper hears it', async () => {
    test.setTimeout(300_000)
    const voices = (await page.evaluate(() => window.api.ttsVoices())) as Array<{ id: string }>
    expect(voices.map(({ id }) => id)).toContain('ff_siwis')

    const { dataUrl } = (await page.evaluate(
      () => window.api.speak('Bonjour. Le marché ouvre demain matin à neuf heures.', 'ff_siwis'),
      undefined
    )) as { dataUrl: string }
    const wav = Buffer.from(dataUrl.split(',')[1]!, 'base64')
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE')
    expect(wav.length).toBeGreaterThan(16_000)

    // AI activity says which engine spoke.
    const spoken = (await page.evaluate(async () => {
      const { rows } = await window.api.aiLogsList({ modality: 'tts' })
      return rows[0] ? window.api.aiLogsDetail(rows[0].id) : null
    })) as { status: string; metrics?: Record<string, unknown> } | null
    expect(spoken).toMatchObject({ status: 'completed', metrics: { engine: 'executorch' } })

    // Whisper hears the French words back.
    const heard = (await page.evaluate(
      (audio) =>
        window.api.transcribeAudio(
          Uint8Array.from(atob(audio), (c) => c.charCodeAt(0)),
          'wav',
          'french-voice-check'
        ),
      wav.toString('base64')
    )) as { text?: string } | string
    const text = (typeof heard === 'string' ? heard : (heard.text ?? '')).toLowerCase()
    expect(text).toMatch(/bonjour/)
    expect(text).toMatch(/demain|neuf|marché/)
  })
})
