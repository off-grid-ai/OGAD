/**
 * APP-045 — a local model reply is visibly incremental, completes, and survives relaunch.
 *
 * The only fake is the native llama-server executable/HTTP boundary. MemoryChat,
 * navigation, preload, IPC, the streaming transport, SQLite, and both Electron
 * processes are production code. The fake binds loopback only and audits the actual
 * request, making the local-only model path explicit without mocking Off Grid code.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid } from './helpers/launch'

const PROMPT = 'Prove this reply streams locally.'
const FIRST_CHUNK = 'APP-045 local first chunk'
const COMPLETE_REPLY = `${FIRST_CHUNK} arrives, then completes offline.`

let app: ElectronApplication | null = null
let page: Page
let userDataDir: string
let auditFile: string
let binDir: string

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

async function launchApp(): Promise<void> {
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_BIN_DIR: binDir,
      OFFGRID_APP045_AUDIT_FILE: auditFile,
      OFFGRID_PRO: '0',
      NODE_ENV: 'production',
      // Cloud credentials are deliberately absent. Proxy-aware clients also have
      // no external route, while the production model transport remains loopback.
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
}

async function enterChat(): Promise<void> {
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  await expect(page.getByPlaceholder(/ask anything/i)).toBeVisible()

  const captureDismiss = page.getByRole('button', { name: 'Dismiss', exact: true })
  if (await captureDismiss.isVisible().catch(() => false)) await captureDismiss.click()
}

function installLocalModelBoundary(): void {
  const modelsDir = path.join(userDataDir, 'models')
  const llamaDir = path.join(binDir, 'llama')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.mkdirSync(llamaDir, { recursive: true })

  const model = Buffer.alloc(2_048)
  model.write('GGUF')
  fs.writeFileSync(path.join(modelsDir, 'app045-local.gguf'), model)
  fs.writeFileSync(
    path.join(modelsDir, 'active-model.json'),
    JSON.stringify({ id: 'app045-local-model', primary: 'app045-local.gguf', mmproj: null })
  )

  const executable = path.join(llamaDir, 'llama-server')
  fs.copyFileSync(
    path.join(process.cwd(), 'e2e', 'fixtures', 'app045-streaming-llama-server.mjs'),
    executable
  )
  fs.chmodSync(executable, 0o755)
}

test.beforeEach(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-app045-'))
  auditFile = path.join(userDataDir, 'local-model-audit.jsonl')
  binDir = path.join(userDataDir, 'bin')
  installLocalModelBoundary()
  await launchApp()
  await enterChat()
})

test.afterEach(async () => {
  await closeApp()
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

test('renders an incremental local reply, completes it, and restores it after relaunch', async () => {
  const composer = page.getByPlaceholder(/ask anything/i)
  await composer.fill(PROMPT)
  await page.keyboard.press('Enter')

  await expect(page.getByText(PROMPT, { exact: true }).last()).toBeVisible()
  await expect(page.getByText(FIRST_CHUNK, { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible()
  await expect(page.getByText(COMPLETE_REPLY, { exact: true })).toHaveCount(0)
  await page.screenshot({
    path: process.env.OFFGRID_APP045_SCREENSHOT ?? path.join(userDataDir, 'app045-incremental.png')
  })

  await expect(page.getByText(COMPLETE_REPLY, { exact: true }).last()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden()

  const audit = fs
    .readFileSync(auditFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  expect(audit).toContainEqual(
    expect.objectContaining({ event: 'listening', address: '127.0.0.1' })
  )
  expect(audit).toContainEqual(expect.objectContaining({ event: 'completion', stream: true }))
  expect(audit).toContainEqual(
    expect.objectContaining({
      event: 'request',
      method: 'POST',
      url: '/v1/chat/completions',
      remoteAddress: '127.0.0.1'
    })
  )

  await closeApp()
  await launchApp()
  await enterChat()

  // A new renderer and main process reopen the same SQLite profile. The latest
  // conversation is selected through the normal MemoryChat loading path.
  await expect(page.getByText(PROMPT, { exact: true }).last()).toBeVisible()
  await expect(page.getByText(COMPLETE_REPLY, { exact: true }).last()).toBeVisible()
  await expect(page.getByText(FIRST_CHUNK, { exact: true })).toHaveCount(0)
})
