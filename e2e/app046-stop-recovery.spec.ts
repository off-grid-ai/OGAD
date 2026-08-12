/**
 * APP-046 — stopping a streamed reply keeps valid partial content and the
 * engine accepts the next prompt exactly once.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'

const FIRST_PROMPT = 'Stream a long answer that I will stop.'
const PARTIAL = 'APP-046 partial answer stays visible.'
const FORBIDDEN_TAIL = 'FORBIDDEN TAIL AFTER STOP.'
const SECOND_PROMPT = 'Prove the engine accepts the next prompt.'
const RECOVERED = 'APP-046 engine recovered exactly once.'

let app: ElectronApplication | null = null
let page: Page
let profileDir: string
let binDir: string
let auditFile: string

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
}

async function closeApp(): Promise<void> {
  const running = app
  if (!running) return
  app = null
  const child = running.process()
  await running.close()
  await waitForExit(child)
}

function installModelBoundary(): void {
  const modelsDir = path.join(profileDir, 'models')
  const llamaDir = path.join(binDir, 'llama')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.mkdirSync(llamaDir, { recursive: true })

  const model = Buffer.alloc(2_048)
  model.write('GGUF')
  fs.writeFileSync(path.join(modelsDir, 'app046-local.gguf'), model)
  fs.writeFileSync(
    path.join(modelsDir, 'active-model.json'),
    JSON.stringify({ id: 'app046-local-model', primary: 'app046-local.gguf', mmproj: null })
  )

  const executable = path.join(llamaDir, 'llama-server')
  fs.copyFileSync(
    path.join(process.cwd(), 'e2e', 'fixtures', 'app046-stop-recovery-llama-server.mjs'),
    executable
  )
  fs.chmodSync(executable, 0o755)
}

async function launchApp(): Promise<void> {
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profileDir,
      OFFGRID_BIN_DIR: binDir,
      OFFGRID_APP046_AUDIT_FILE: auditFile,
      OFFGRID_PRO: '0',
      NODE_ENV: 'production',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      GOOGLE_API_KEY: '',
      HF_TOKEN: '',
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      ALL_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: '127.0.0.1,localhost'
    },
    extraArgs: ['--proxy-server=http://127.0.0.1:9']
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  await expect(page.getByPlaceholder(/ask anything/i)).toBeVisible()
  const dismiss = page.getByRole('button', { name: 'Dismiss', exact: true })
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click()
}

const audit = (): Array<Record<string, unknown>> => {
  if (!fs.existsSync(auditFile)) return []
  return fs
    .readFileSync(auditFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

test.describe('APP-046 streamed stop recovery', () => {
  test.skip(targetIsPackaged(), 'This native-model boundary is for the source-built E2E target.')

  test.beforeEach(async () => {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-app046-'))
    binDir = path.join(profileDir, 'bin')
    auditFile = path.join(profileDir, 'app046-audit.jsonl')
    installModelBoundary()
    await launchApp()
  })

  // Playwright requires the first callback argument to use object destructuring.
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    await closeApp()
    if (fs.existsSync(auditFile)) {
      fs.copyFileSync(auditFile, testInfo.outputPath('app046-model-audit.jsonl'))
    }
    fs.rmSync(profileDir, { recursive: true, force: true })
  })

  // Playwright requires the first callback argument to use object destructuring.
  // eslint-disable-next-line no-empty-pattern
  test('keeps partial text after Stop and completes the next prompt once', async ({}, testInfo) => {
    const composer = page.getByPlaceholder(/ask anything/i)
    await composer.fill(FIRST_PROMPT)
    await page.keyboard.press('Enter')

    await expect(page.getByText(PARTIAL, { exact: true }).last()).toBeVisible({ timeout: 15_000 })
    const stop = page.getByRole('button', { name: 'Stop generating' })
    await expect(stop).toBeVisible()
    await stop.click()

    await expect(stop).toBeHidden()
    await expect(page.getByText(PARTIAL, { exact: true }).last()).toBeVisible()
    await expect(page.getByText(FORBIDDEN_TAIL, { exact: false })).toHaveCount(0)
    await expect
      .poll(
        () => audit().filter((entry) => entry.event === 'completion-cancelled-after-partial').length
      )
      .toBe(1)

    await composer.fill(SECOND_PROMPT)
    await page.keyboard.press('Enter')
    await expect(page.getByText(RECOVERED, { exact: true }).last()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(RECOVERED, { exact: true })).toHaveCount(2)
    await expect(page.getByText(FORBIDDEN_TAIL, { exact: false })).toHaveCount(0)
    expect(audit().filter((entry) => entry.event === 'completion-finished')).toEqual([
      expect.objectContaining({ secondTurn: true })
    ])

    await page.screenshot({
      path:
        process.env.OFFGRID_APP046_SCREENSHOT ??
        testInfo.outputPath('app046-stopped-and-recovered.png')
    })

    await closeApp()
    await launchApp()
    await expect(page.getByText(PARTIAL, { exact: true }).last()).toBeVisible()
    await expect(page.getByText(RECOVERED, { exact: true }).last()).toBeVisible()
    await expect(page.getByText(FORBIDDEN_TAIL, { exact: false })).toHaveCount(0)
  })
})
