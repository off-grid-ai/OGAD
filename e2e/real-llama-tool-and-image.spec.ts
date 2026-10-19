/**
 * Real llama.cpp: a question that needs a tool runs it and answers, and a question about an attached
 * image is answered from the picture. No fakes: the bundled llama-server (resources/bin/llama) and a
 * real vision model with its projector.
 *
 * Local only. It skips unless the model files are installed in the app's models folder; the profile
 * is a temp dir that borrows the model files by hard link, so nothing in the real profile changes.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import { completeOnboarding } from './helpers/onboarding'
import { enginePortsUnavailableReason } from './helpers/ports'
import { closeAndWait } from './helpers/windows'

const REAL_MODELS = path.join(
  os.homedir(),
  'Library/Application Support/Off Grid AI Desktop/models'
)
/** The first installed vision model wins. */
const VISION_MODELS = [
  { primary: 'gemma-4-E4B-it-Q4_K_M.gguf', mmproj: 'mmproj-gemma-4-E4B-it-F16.gguf' },
  { primary: 'gemma-4-E2B-it-Q4_K_M.gguf', mmproj: 'mmproj-gemma-4-E2B-it-F16.gguf' }
]
const MODEL = VISION_MODELS.find(
  ({ primary, mmproj }) =>
    fs.existsSync(path.join(REAL_MODELS, primary)) && fs.existsSync(path.join(REAL_MODELS, mmproj))
)
const ENGINE = path.resolve('resources/bin/llama/llama-server')

let app: ElectronApplication | null = null
let page: Page
let profileDir: string

/** Send a message and wait until the answer has finished. Returns the answer's text. */
async function ask(question: string): Promise<string> {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  await composer.fill(question)
  await composer.press('Enter')
  const stop = page.getByRole('button', { name: 'Stop generating', exact: true })
  await expect(stop).toBeVisible({ timeout: 30_000 })
  await expect(stop).toBeHidden({ timeout: 180_000 })
  // The answer is the last message of the chat.
  return (await page.locator('[data-testid^="chat-message-"]').last().innerText()).trim()
}

test.describe('Real llama.cpp', () => {
  test.skip(targetIsPackaged(), 'Runs against the source build and the bundled engine.')
  test.skip(
    !MODEL || !fs.existsSync(ENGINE),
    'needs a real vision model and the bundled llama-server'
  )

  test.beforeEach(async () => {
    const busy = await enginePortsUnavailableReason()
    test.skip(busy !== null, busy ?? '')
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-real-llama-'))
    const models = path.join(profileDir, 'models')
    fs.mkdirSync(models, { recursive: true })
    for (const file of [MODEL!.primary, MODEL!.mmproj])
      fs.linkSync(path.join(REAL_MODELS, file), path.join(models, file))
    fs.writeFileSync(
      path.join(models, 'active-model.json'),
      JSON.stringify({ id: 'real-vision-model', primary: MODEL!.primary, mmproj: MODEL!.mmproj })
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
    await page.getByRole('button', { name: 'Chat', exact: true }).click()
  })

  test.afterEach(async () => {
    if (app) await closeAndWait(app)
    app = null
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true })
  })

  test('a tool call and an image question both complete', async () => {
    test.setTimeout(420_000)
    const year = String(new Date().getFullYear())

    // A question only the clock can answer: the tool runs, shows in the work timeline, and the
    // answer carries this year.
    const dated = await ask('What is the date today? Use the date and time tool, then tell me.')
    expect(dated).toContain(year)
    await page.getByRole('button', { name: 'Work done', exact: true }).last().click()
    await expect(
      page.getByRole('list', { name: 'Tool calls' }).last().getByText(/date/i).first()
    ).toBeVisible()

    // A question about an attached picture is answered from the picture.
    const picture = path.join(profileDir, 'red-square.png')
    await sharp({ create: { width: 256, height: 256, channels: 3, background: '#e01010' } })
      .png()
      .toFile(picture)
    await page.getByRole('button', { name: 'Composer options', exact: true }).click()
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('menuitem', { name: 'Attach files', exact: true }).click()
    await (await chooser).setFiles(picture)
    await expect(page.getByText('red-square.png').first()).toBeVisible()
    const seen = await ask('What colour fills this image? Answer with one word.')
    expect(seen).toMatch(/red/i)

    // The engine is still up after both.
    await expect(page.getByRole('button', { name: /^Model server: model running/ })).toBeVisible()
  })
})
