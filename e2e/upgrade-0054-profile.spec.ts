/**
 * A profile left by 0.0.54 keeps what the person set by hand, and keeps capturing the clipboard.
 *
 * The profile is shaped the way 0.0.54 leaves one: a plaintext settings database (later builds
 * encrypt new ones, and keep an existing plaintext one as it is) with hand-set residency and
 * backends, a hand-picked resource mode in llm-settings.json, an active chat model, no record of
 * the new "best settings" start-up step and no saved clipboard choice. The only boundary is a
 * fake llama-server that records each launch.
 *
 * Asserts: after the first start on this build, Settings still shows the hand-picked resource
 * mode, residency and backends are unchanged, the same model starts, and copied text appears in
 * Clipboard. A saved clipboard "Off" from 0.0.54 is still honoured.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import { gotoSettings, openSettingsSection } from './helpers/settings'
import { closeAndWait, gotoScreen, mainWindow } from './helpers/windows'

const PRO_PRESENT = fs.existsSync(path.resolve('pro/package.json'))
const RESIDENCY = { embeddings: 'on-demand', grounding: 'on-demand', stt: 'resident' }
const BACKENDS = { llm: 'cpu', embeddings: 'cpu' }

let app: ElectronApplication | null = null
let page: Page
let profileDir: string
let launchLog: string

const sql = (value: string): string => `'${value.replaceAll("'", "''")}'`

/** A 0.0.54 profile: plaintext settings, a hand-picked mode and an active model. */
const seedProfile = (settings: Record<string, unknown>): void => {
  const modelsDir = path.join(profileDir, 'models')
  const llamaDir = path.join(profileDir, 'bin', 'llama')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.mkdirSync(llamaDir, { recursive: true })
  const gguf = Buffer.alloc(2_048)
  gguf.write('GGUF')
  fs.writeFileSync(path.join(modelsDir, 'upgrade-chat.gguf'), gguf)
  fs.writeFileSync(
    path.join(modelsDir, 'active-model.json'),
    JSON.stringify({ id: 'upgrade-chat-model', primary: 'upgrade-chat.gguf', mmproj: null })
  )
  fs.writeFileSync(
    path.join(modelsDir, 'llm-settings.json'),
    JSON.stringify({
      performanceMode: 'extreme',
      ctxSize: 65536,
      kvCacheType: 'f16',
      flashAttn: false
    })
  )
  const executable = path.join(llamaDir, 'llama-server')
  fs.copyFileSync(path.resolve('e2e/fixtures/launch-log-llama-server.mjs'), executable)
  fs.chmodSync(executable, 0o755)
  const rows = Object.entries(settings)
    .map(([key, value]) => `(${sql(key)}, ${sql(JSON.stringify(value))})`)
    .join(',\n')
  execFileSync('sqlite3', [
    path.join(profileDir, 'memories.db'),
    `CREATE TABLE app_settings (
       key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
     );
     INSERT INTO app_settings (key, value) VALUES ${rows};`
  ])
}

const launch = async (): Promise<void> => {
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profileDir,
      OFFGRID_BIN_DIR: path.join(profileDir, 'bin'),
      OFFGRID_LLAMA_LAUNCH_LOG: launchLog,
      OFFGRID_PRO: '1',
      NODE_ENV: 'production',
      NO_PROXY: '127.0.0.1,localhost'
    }
  })
  page = await mainWindow(app)
  await completeOnboarding(page)
}

/** Text the person copies in another app. */
const copy = (text: string): Promise<void> =>
  app!.evaluate(({ clipboard }, value) => clipboard.writeText(value), text)

test.describe('Upgrading a 0.0.54 profile', () => {
  test.skip(targetIsPackaged(), 'This native-model boundary is for the source-built E2E target.')

  test.beforeEach(() => {
    test.skip(!PRO_PRESENT, 'pro package not present: Clipboard is a Pro surface')
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-upgrade-0054-'))
    launchLog = path.join(profileDir, 'llama-launches.jsonl')
  })

  test.afterEach(async () => {
    if (app) await closeAndWait(app)
    app = null
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true })
  })

  test('Hand-set settings survive the first start, and the clipboard is captured', async () => {
    test.setTimeout(150_000)
    seedProfile({
      'runtime:residency': RESIDENCY,
      'runtime:backend-preferences': BACKENDS
    })
    await launch()

    // The same model starts, with the hand-picked mode's window.
    await expect
      .poll(
        () =>
          fs.existsSync(launchLog)
            ? fs.readFileSync(launchLog, 'utf8').includes('upgrade-chat.gguf')
            : false,
        { timeout: 30_000 }
      )
      .toBe(true)
    await gotoSettings(page)
    await openSettingsSection(page, 'Setup & health')
    await expect(page.getByRole('radio', { name: 'Extreme', exact: true }).first()).toHaveAttribute(
      'aria-checked',
      'true'
    )
    const after = await page.evaluate(async () => ({
      residency: (await window.api.residencyGet()) as Record<string, string>,
      llm: (await window.api.getLlmSettings()) as { performanceMode?: string; ctxSize?: number }
    }))
    expect(after.residency).toMatchObject(RESIDENCY)
    expect(after.llm.performanceMode).toBe('extreme')
    expect(after.llm.ctxSize).toBe(65536)
    const backends = execFileSync('sqlite3', [
      path.join(profileDir, 'memories.db'),
      "SELECT value FROM app_settings WHERE key = 'runtime:backend-preferences'"
    ])
      .toString()
      .trim()
    expect(JSON.parse(backends)).toMatchObject(BACKENDS)

    // Clipboard capture is on, as it was in 0.0.54, with no saved choice.
    const copied = `Upgrade clipboard check ${Date.now()}`
    await copy(copied)
    await gotoScreen(page, 'Clipboard')
    await expect(page.getByText(copied).first()).toBeVisible({ timeout: 20_000 })
  })

  test('A clipboard "Off" saved in 0.0.54 is still honoured', async () => {
    test.setTimeout(120_000)
    seedProfile({
      'clipboard:settings': { captureEnabled: false, maxItems: 1000, retentionDays: 0 }
    })
    await launch()
    const copied = `Upgrade clipboard off ${Date.now()}`
    await copy(copied)
    await gotoScreen(page, 'Clipboard')
    await page.waitForTimeout(4_000)
    await expect(page.getByText(copied)).toHaveCount(0)
  })
})
