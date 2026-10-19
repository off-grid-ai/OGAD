/**
 * A resource mode the engine cannot start with is rolled back.
 *
 * Real app; the only boundary is a fake llama-server that refuses the quantized KV cache flag
 * that Conservative adds, the way a llama.cpp build without that option does. The person picks
 * Conservative in Settings → Setup & health. The engine fails to start, so the app must say so,
 * select the mode that was working again, and still answer in chat with that mode's launch.
 */
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import { gotoSettings, openSettingsSection } from './helpers/settings'
import { closeAndWait, mainWindow } from './helpers/windows'

const WARM_UP = 'Are you there?'
const QUESTION = 'Are you still answering after the mode change?'
const ANSWER = 'The local engine answered.'

let app: ElectronApplication | null = null
let page: Page
let profileDir: string
let modelLog: string

interface LogEntry {
  event: 'launch' | 'chat'
  args?: string[]
  body?: string
}

const entries = (): LogEntry[] =>
  fs.existsSync(modelLog)
    ? fs
        .readFileSync(modelLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LogEntry)
    : []

const launches = (): string[][] =>
  entries()
    .filter((entry) => entry.event === 'launch')
    .map((entry) => entry.args ?? [])

const installModelBoundary = (): void => {
  const modelsDir = path.join(profileDir, 'models')
  const llamaDir = path.join(profileDir, 'bin', 'llama')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.mkdirSync(llamaDir, { recursive: true })
  const model = Buffer.alloc(2_048)
  model.write('GGUF')
  fs.writeFileSync(path.join(modelsDir, 'resource-mode.gguf'), model)
  fs.writeFileSync(
    path.join(modelsDir, 'active-model.json'),
    JSON.stringify({ id: 'resource-mode-model', primary: 'resource-mode.gguf', mmproj: null })
  )
  const executable = path.join(llamaDir, 'llama-server')
  fs.copyFileSync(path.resolve('e2e/fixtures/launch-log-llama-server.mjs'), executable)
  fs.chmodSync(executable, 0o755)
}

/** Asks in chat and waits until the engine has answered that request. */
const ask = async (question: string): Promise<void> => {
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  await composer.fill(question)
  await composer.press('Enter')
  await expect
    .poll(
      () => entries().some((entry) => entry.event === 'chat' && entry.body?.includes(question)),
      { timeout: 60_000 }
    )
    .toBe(true)
  await expect(page.getByText(ANSWER).first()).toBeVisible({ timeout: 30_000 })
}

const modeRadio = (label: string): Locator =>
  page.getByRole('radio', { name: label, exact: true }).first()

test.describe('Resource mode rollback', () => {
  test.skip(targetIsPackaged(), 'This native-model boundary is for the source-built E2E target.')

  test.beforeEach(async () => {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-resource-mode-'))
    modelLog = path.join(profileDir, 'model-log.jsonl')
    installModelBoundary()
    app = await launchOffGrid({
      env: {
        ...process.env,
        OFFGRID_USER_DATA: profileDir,
        OFFGRID_BIN_DIR: path.join(profileDir, 'bin'),
        OFFGRID_LLAMA_LAUNCH_LOG: modelLog,
        OFFGRID_PRO: '0',
        NODE_ENV: 'production',
        NO_PROXY: '127.0.0.1,localhost'
      }
    })
    page = await mainWindow(app)
    await completeOnboarding(page)
  })

  // Playwright requires the first callback argument to use object destructuring.
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    if (app) await closeAndWait(app)
    app = null
    if (fs.existsSync(modelLog)) fs.copyFileSync(modelLog, testInfo.outputPath('model-log.jsonl'))
    fs.rmSync(profileDir, { recursive: true, force: true })
  })

  test('A mode the engine refuses shows an error, selects the working mode again, and chat still answers', async () => {
    test.setTimeout(120_000)
    // The model loads on its first use, never at launch: a first chat starts the engine, which a
    // mode change then relaunches.
    await ask(WARM_UP)
    expect(launches().length).toBeGreaterThanOrEqual(1)
    await gotoSettings(page)
    await openSettingsSection(page, 'Setup & health')
    // Balanced is the working mode; a profile sized to another one is switched to it first.
    await modeRadio('Balanced').click()
    await expect(modeRadio('Balanced')).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByRole('alert')).toHaveCount(0)
    const before = launches().length

    await modeRadio('Conservative').click()

    // The engine was asked to start with Conservative's flag and refused it.
    await expect
      .poll(
        () =>
          launches()
            .slice(before)
            .some((args) => args.includes('--cache-type-k')),
        {
          timeout: 30_000
        }
      )
      .toBe(true)
    await expect(page.getByRole('alert')).toContainText(
      'Conservative could not start the model. Balanced is still in use.',
      { timeout: 30_000 }
    )
    await expect(modeRadio('Balanced')).toHaveAttribute('aria-checked', 'true')
    await expect(modeRadio('Conservative')).toHaveAttribute('aria-checked', 'false')
    // The previous launch is started again, without the refused flag.
    await expect
      .poll(
        () => {
          const after = launches().slice(before)
          const last = after[after.length - 1]
          return after.length >= 2 && last !== undefined && !last.includes('--cache-type-k')
        },
        { timeout: 30_000 }
      )
      .toBe(true)

    await ask(QUESTION)

    // The rollback is what is saved, so a relaunch also comes back on Balanced.
    await closeAndWait(app!)
    app = await launchOffGrid({
      env: {
        ...process.env,
        OFFGRID_USER_DATA: profileDir,
        OFFGRID_BIN_DIR: path.join(profileDir, 'bin'),
        OFFGRID_LLAMA_LAUNCH_LOG: modelLog,
        OFFGRID_PRO: '0',
        NODE_ENV: 'production',
        NO_PROXY: '127.0.0.1,localhost'
      }
    })
    page = await mainWindow(app)
    await completeOnboarding(page)
    await gotoSettings(page)
    await openSettingsSection(page, 'Setup & health')
    await expect(modeRadio('Balanced')).toHaveAttribute('aria-checked', 'true')
  })
})
