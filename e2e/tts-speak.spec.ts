/**
 * RELEASE_TEST_CHECKLIST #105 - the rendered Speak action reaches the production
 * TTS path, strips markdown for speech, returns playable local WAV audio, and can
 * be stopped. Only the external Kokoro native model is replaced.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let app: ElectronApplication
let page: Page
let userDataDir: string
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

test.beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-tts-speak-'))
  userDataDir = path.join(root, 'profile')
  fs.mkdirSync(path.join(userDataDir, 'models'), { recursive: true })
  spokenTextPath = path.join(root, 'spoken.txt')

  const env: Record<string, string> = {
    ...process.env,
    OFFGRID_USER_DATA: userDataDir,
    OFFGRID_TTS_CAPTURE: spokenTextPath,
    OFFGRID_PRO: '1',
    NODE_ENV: 'production'
  }
  delete env.ELECTRON_RUN_AS_NODE
  // b7918e7ea moved English speech to the ONNX worker. Its native model is the only fake.
  app = await launchOffGrid({ env, appEntry: 'e2e/fixtures/tts-kokoro-boundary.cjs' })
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
  const log = path.join(userDataDir, 'logs/off-grid-ai-desktop.log')
  if (fs.existsSync(log)) await test.info().attach('app-log', { path: log })
  await app?.close()
  fs.rmSync(path.dirname(userDataDir), { recursive: true, force: true })
})

test('Speak sends clean text through production TTS and plays local WAV audio (#105)', async () => {
  await expect(
    page.getByRole('heading', { name: 'A local reply with code', exact: true })
  ).toBeVisible()

  await page.getByRole('button', { name: 'Message actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Speak', exact: true }).click()
  await page.getByRole('button', { name: 'Message actions', exact: true }).click()
  // Generous for the PACKAGED build: first synthesis spawns the TTS worker from inside the
  // signed bundle, which is slower to start than the dev path (the same cold-start effect that
  // makes the packaged gateway need ~25s in smoke.spec.ts).
  await expect(page.getByRole('menuitem', { name: 'Stop', exact: true })).toBeVisible({
    timeout: 45_000
  })
  // Source runs record text at the native model boundary. Packaged runs use their bundled model.
  if (!targetIsPackaged()) {
    await expect.poll(() => fs.existsSync(spokenTextPath)).toBe(true)
    expect(fs.readFileSync(spokenTextPath, 'utf8')).toBe('A local reply with code')
  }

  await page.getByRole('menuitem', { name: 'Stop', exact: true }).click()
  await page.getByRole('button', { name: 'Message actions', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Speak', exact: true })).toBeVisible()
})
