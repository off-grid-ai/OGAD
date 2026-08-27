/**
 * RELEASE_TEST_CHECKLIST #105 - the rendered Speak action reaches the production
 * TTS path, strips markdown for speech, returns playable local WAV audio, and can
 * be stopped. The heavyweight ONNX worker is the only replaced boundary.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let app: ElectronApplication
let page: Page
let userDataDir: string
let resourceDir: string
let spokenTextPath: string

async function finishOnboarding(): Promise<void> {
  for (let step = 0; step < 8; step += 1) {
    const button = page.getByRole('button', { name: /Continue|Start using Off Grid AI/i })
    if (!(await button.isVisible().catch(() => false))) return
    await button.click()
  }
}

async function dismissCapturePrompt(): Promise<void> {
  const dismiss = page.getByRole('button', { name: 'Dismiss', exact: true })
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click()
}

function writeWorkerFixture(): void {
  fs.mkdirSync(resourceDir, { recursive: true })
  fs.writeFileSync(
    path.join(resourceDir, 'tts-worker.mjs'),
    [
      "import fs from 'node:fs'",
      'const [, , command, output] = process.argv',
      "if (command !== 'speak' || !output) process.exit(2)",
      "let input = ''",
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data', chunk => { input += chunk })",
      "process.stdin.on('end', () => {",
      '  fs.writeFileSync(process.env.OFFGRID_TTS_CAPTURE, input)',
      '  const sampleRate = 16000',
      '  const sampleCount = sampleRate * 2',
      '  const wav = Buffer.alloc(44 + sampleCount * 2)',
      "  wav.write('RIFF', 0)",
      '  wav.writeUInt32LE(36 + sampleCount * 2, 4)',
      "  wav.write('WAVE', 8)",
      "  wav.write('fmt ', 12)",
      '  wav.writeUInt32LE(16, 16)',
      '  wav.writeUInt16LE(1, 20)',
      '  wav.writeUInt16LE(1, 22)',
      '  wav.writeUInt32LE(sampleRate, 24)',
      '  wav.writeUInt32LE(sampleRate * 2, 28)',
      '  wav.writeUInt16LE(2, 32)',
      '  wav.writeUInt16LE(16, 34)',
      "  wav.write('data', 36)",
      '  wav.writeUInt32LE(sampleCount * 2, 40)',
      '  for (let index = 0; index < sampleCount; index += 1) {',
      '    const sample = Math.sin((index / sampleRate) * Math.PI * 440) * 4000',
      '    wav.writeInt16LE(Math.round(sample), 44 + index * 2)',
      '  }',
      '  fs.writeFileSync(output, wav)',
      '})'
    ].join('\n'),
    { mode: 0o755 }
  )
}

test.beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-tts-speak-'))
  userDataDir = path.join(root, 'profile')
  resourceDir = path.join(root, 'resources')
  spokenTextPath = path.join(root, 'spoken.txt')
  writeWorkerFixture()

  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_RESOURCE_DIR: resourceDir,
      OFFGRID_TTS_CAPTURE: spokenTextPath,
      OFFGRID_PRO: '1',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await finishOnboarding()
  await expect(page.getByRole('button', { name: 'Chat', exact: true })).toBeVisible()

  await page.evaluate(async () => {
    await window.api.createRagConversation('tts-speak-release', 'Speak release reply', null)
    await window.api.addRagMessage(
      'tts-speak-release',
      'assistant',
      '## A **local** [reply](https://example.invalid) with `code`'
    )
  })
  await page
    .getByRole('button', { name: /chat|mind|ask/i })
    .first()
    .click()
  await dismissCapturePrompt()
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(path.dirname(userDataDir), { recursive: true, force: true })
})

test('Speak sends clean text through production TTS and plays local WAV audio (#105)', async () => {
  await expect(page.getByText('A local reply with code', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Speak', exact: true }).click()
  // Generous for the PACKAGED build: first synthesis spawns the TTS worker from inside the
  // signed bundle, which is slower to start than the dev path (the same cold-start effect that
  // makes the packaged gateway need ~25s in smoke.spec.ts).
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible({
    timeout: 45_000
  })
  // The markdown-stripping assertion relies on the FAKE tts-worker injected via
  // OFFGRID_RESOURCE_DIR. A packaged host deliberately ignores that override for executable
  // code (runtime-env.ts applicationCodeFile: honouring it would let external JavaScript bypass
  // the integrity-checked ASAR — the anti-tamper lever behind the ASAR fuses). So on the
  // packaged target the REAL Kokoro worker runs and no capture file is written. Assert the real
  // path there rather than weakening that control; the dev target keeps the text-cleanup check.
  if (!targetIsPackaged()) {
    await expect.poll(() => fs.existsSync(spokenTextPath)).toBe(true)
    expect(fs.readFileSync(spokenTextPath, 'utf8')).toBe('A local reply with code')
  }

  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Speak', exact: true })).toBeVisible()
})
