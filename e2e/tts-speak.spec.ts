/**
 * RELEASE_TEST_CHECKLIST #105 - the rendered Speak action reaches the production
 * TTS path, strips markdown for speech, returns playable local WAV audio, and can
 * be stopped. The native ExecuTorch speech executable and its model assets are
 * the only replaced boundary.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

let app: ElectronApplication
let page: Page
let userDataDir: string
let resourceDir: string
let spokenTextPath: string
let diagnosticLogPath: string

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

function bundledAssetName(assetName: string, url: string): string {
  const sourceId = createHash('sha256').update(url).digest('hex').slice(0, 12)
  return `${assetName}-${sourceId}-${path.basename(new URL(url).pathname)}`
}

function writeSpeechBoundary(): void {
  const speechCapabilities = JSON.parse(
    fs.readFileSync(
      path.resolve('node_modules/@offgrid/executorch-speech/generated/capabilities.json'),
      'utf8'
    )
  ) as { voices: Array<{ assets: Record<string, string> }> }
  const executableDir = path.join(resourceDir, 'bin')
  const assetsDir = path.join(resourceDir, 'speech-assets')
  fs.mkdirSync(executableDir, { recursive: true })
  fs.mkdirSync(assetsDir, { recursive: true })
  const index: Record<string, { url: string; bytes: number }> = {}
  for (const voice of speechCapabilities.voices) {
    for (const [assetName, url] of Object.entries(voice.assets)) {
      if (typeof url !== 'string') continue
      const fileName = bundledAssetName(assetName, url)
      if (index[fileName]) continue
      const bytes = Buffer.from(`e2e-${assetName}`)
      fs.writeFileSync(path.join(assetsDir, fileName), bytes)
      index[fileName] = { url, bytes: bytes.length }
    }
  }
  fs.writeFileSync(path.join(assetsDir, 'index.json'), JSON.stringify(index))
  fs.writeFileSync(
    path.join(executableDir, 'executorch-speech'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs')",
      'const args = process.argv.slice(2)',
      "const outputIndex = args.indexOf('--output')",
      'const output = outputIndex >= 0 ? args[outputIndex + 1] : null',
      'if (!output) process.exit(2)',
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
  diagnosticLogPath = path.join(root, 'diagnostic.log')
  writeSpeechBoundary()

  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_RESOURCE_DIR: resourceDir,
      OFFGRID_TTS_CAPTURE: spokenTextPath,
      OFFGRID_DIAGNOSTIC_LOG: diagnosticLogPath,
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
  if (process.env.OFFGRID_KEEP_E2E_PROFILE !== '1') {
    fs.rmSync(path.dirname(userDataDir), { recursive: true, force: true })
  }
})

test('Speak sends clean text through production TTS and plays local WAV audio (#105)', async () => {
  await expect(page.getByRole('heading', { name: 'A local reply with code' })).toBeVisible()

  await page.getByRole('button', { name: 'Speak', exact: true }).click()
  // Generous for the PACKAGED build: first synthesis starts the speech executable from inside the
  // signed bundle, which is slower to start than the dev path (the same cold-start effect that
  // makes the packaged gateway need ~25s in smoke.spec.ts).
  const stop = page.getByRole('button', { name: 'Stop', exact: true })
  const failure = page.getByRole('alert')
  const speechState = await Promise.race([
    stop.waitFor({ state: 'visible', timeout: 45_000 }).then(() => 'ready' as const),
    failure.waitFor({ state: 'visible', timeout: 45_000 }).then(() => 'failed' as const)
  ])
  if (speechState === 'failed') {
    const diagnostics = fs.existsSync(diagnosticLogPath)
      ? fs
          .readFileSync(diagnosticLogPath, 'utf8')
          .trim()
          .split('\n')
          .filter((line) => /\[(?:tts|generation)\]|voice/i.test(line))
          .slice(-8)
          .join(' | ')
      : 'no diagnostics'
    throw new Error(`Speech boundary failed: ${diagnostics}`)
  }
  // The markdown-stripping assertion relies on the scripted ExecuTorch-compatible boundary injected via
  // OFFGRID_RESOURCE_DIR. A packaged host deliberately ignores that override for executable
  // code (runtime-env.ts applicationCodeFile: honouring it would let external JavaScript bypass
  // the integrity-checked ASAR — the anti-tamper lever behind the ASAR fuses). So on the
  // packaged target the real Kokoro runtime runs and no capture file is written. Assert the real
  // path there rather than weakening that control; the dev target keeps the text-cleanup check.
  if (!targetIsPackaged()) {
    await expect.poll(() => fs.existsSync(spokenTextPath)).toBe(true)
    expect(fs.readFileSync(spokenTextPath, 'utf8')).toBe('A local reply with code')
  }

  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Speak', exact: true })).toBeVisible()
})
