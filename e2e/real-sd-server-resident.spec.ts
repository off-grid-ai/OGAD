/**
 * Real resident image server: with image residency on, an image shows forming before it is done,
 * and the second image is made by the same sd-server process.
 *
 * No fakes: the bundled sd-server (resources/bin/sd) and a real turbo checkpoint. Local only. It
 * skips unless the model is installed; the temp profile borrows the file by hard link.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
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
const IMAGE_MODEL = 'dreamshaper-xl-v2-turbo-Q8_0.gguf'
const ENGINE = path.resolve('resources/bin/sd/sd-server')

let app: ElectronApplication | null = null
let page: Page
let profileDir: string

/** sd-server processes the app started. */
const sdServers = (): number[] => {
  try {
    return execFileSync('pgrep', ['-P', String(app!.process().pid), '-f', 'sd-server'], {
      encoding: 'utf8'
    })
      .split('\n')
      .filter(Boolean)
      .map(Number)
  } catch {
    return []
  }
}

async function generate(prompt: string): Promise<void> {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  await composer.fill(prompt)
  await composer.press('Enter')
}

test.describe('Real resident image server', () => {
  test.skip(targetIsPackaged(), 'Runs against the source build and the bundled engine.')
  test.skip(
    !fs.existsSync(path.join(REAL_MODELS, IMAGE_MODEL)) || !fs.existsSync(ENGINE),
    'needs the real turbo image model and the bundled sd-server'
  )

  test.beforeEach(async () => {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-real-sd-'))
    const models = path.join(profileDir, 'models')
    fs.mkdirSync(models, { recursive: true })
    fs.linkSync(path.join(REAL_MODELS, IMAGE_MODEL), path.join(models, IMAGE_MODEL))
    fs.writeFileSync(
      path.join(models, 'active-modalities.json'),
      JSON.stringify({ image: IMAGE_MODEL })
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
    // Settings → Models → memory: keep the image model loaded.
    await page.evaluate(() => window.api.residencySet('image', 'resident'))
    await page.getByRole('button', { name: 'Chat', exact: true }).click()
    await page.getByRole('button', { name: 'Image', exact: true }).click()
  })

  test.afterEach(async () => {
    if (app) await closeAndWait(app)
    app = null
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true })
  })

  test('the image shows forming, and the second one reuses the server', async () => {
    test.setTimeout(600_000)
    await generate('A lighthouse on a rocky coast at dusk')
    await expect(page.getByRole('img', { name: 'forming' })).toBeVisible({ timeout: 240_000 })
    await expect(page.getByRole('img', { name: 'forming' })).toHaveCount(0, { timeout: 240_000 })
    const [server] = sdServers()
    expect(server).toBeGreaterThan(0)

    await generate('A red bicycle against a white wall')
    await expect(page.getByRole('img', { name: 'forming' })).toBeVisible({ timeout: 120_000 })
    await expect(page.getByRole('img', { name: 'forming' })).toHaveCount(0, { timeout: 240_000 })
    expect(sdServers()).toEqual([server])
  })
})
