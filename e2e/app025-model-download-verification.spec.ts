/**
 * APP-025: a rendered model download is staged, verified, activated, used, and restored.
 *
 * Only Hugging Face delivery is controlled. The retry payload is a real Qwen GGUF and the app uses
 * its actual llama-server; all Off Grid UI, IPC, integrity, filesystem, runtime selection, chat,
 * persistence, and relaunch behavior stay production.
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page
} from '@playwright/test'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { targetIsPackaged } from './helpers/launch'

const TARGET_ID = 'unsloth/Qwen3.5-2B-GGUF'
const TARGET_NAME = 'Qwen 3.5 2B'
const TARGET_FILE = 'Qwen3.5-2B-Q4_K_M.gguf'
const TARGET_PROJECTOR = 'mmproj-Qwen3.5-2B-BF16.gguf'
const SOURCE_MODEL =
  process.env.OFFGRID_APP025_REAL_GGUF ??
  path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Off Grid AI Desktop',
    'models',
    TARGET_FILE
  )
const SOURCE_PROJECTOR = path.join(path.dirname(SOURCE_MODEL), TARGET_PROJECTOR)
const CHAT_PROMPT = 'What is two plus two? Answer with only the number.'
const RELAUNCH_PROMPT = 'What is three plus three? Answer with only the number.'

interface NetworkEvent {
  event: 'fixture-ready' | 'model-request' | 'model-response' | 'payload-chunk' | 'payload-complete'
  attempt?: number
  range?: string | null
  kind?: string
  bytes?: number
  totalBytes?: number
}

let app: ElectronApplication | null = null
let page: Page
let profileDir: string
let ledgerPath: string

test.skip(targetIsPackaged(), 'The controlled model-host entry point is source-build only.')
test.skip(
  !fs.existsSync(SOURCE_MODEL) || !fs.existsSync(SOURCE_PROJECTOR),
  `APP-025 requires the real Qwen model and projector beside ${SOURCE_MODEL} (override OFFGRID_APP025_REAL_GGUF).`
)

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
  const fixture = path.resolve('e2e/fixtures/app025-model-download-network-boundary.cjs')
  app = await electron.launch({
    args: [fixture],
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profileDir,
      OFFGRID_APP025_NETWORK_LEDGER: ledgerPath,
      OFFGRID_APP025_REAL_GGUF: SOURCE_MODEL,
      OFFGRID_APP025_REAL_MMPROJ: SOURCE_PROJECTOR,
      OFFGRID_PRO: '0',
      NODE_ENV: 'production',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      GOOGLE_API_KEY: '',
      HF_TOKEN: ''
    }
  })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)
}

function events(): NetworkEvent[] {
  if (!fs.existsSync(ledgerPath)) return []
  return fs
    .readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as NetworkEvent)
}

function modelsDir(): string {
  return path.join(profileDir, 'models')
}

async function openModels(): Promise<void> {
  await page.getByRole('button', { name: 'Models', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Models' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeVisible()
}

function targetCard(): Locator {
  return page
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: TARGET_NAME, exact: true }) })
    .first()
}

async function cardShowsDownloadProgress(card: Locator): Promise<boolean> {
  return /\d+%/.test((await card.textContent()) ?? '')
}

async function sawIntermediateStorageProgress(): Promise<boolean> {
  const id = page.getByText(TARGET_ID, { exact: true })
  if ((await id.count()) === 0) return false
  const text = (await id.first().locator('../..').textContent()) ?? ''
  const match = text.match(/(\d+)%/)
  if (!match) return false
  const value = Number(match[1])
  return value > 0 && value < 100
}

async function enterChat(): Promise<void> {
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  await expect(page.getByPlaceholder(/ask anything/i)).toBeVisible()
}

async function sendPromptAndWaitForAssistant(prompt: string): Promise<Locator> {
  const replies = page.getByRole('button', { name: 'Regenerate', exact: true })
  const previousReplyCount = await replies.count()
  const composer = page.getByPlaceholder(/ask anything/i)
  await composer.fill(prompt)
  await page.keyboard.press('Enter')
  await expect(replies).toHaveCount(previousReplyCount + 1, { timeout: 120_000 })
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({
    timeout: 120_000
  })
  const renderedReply = replies.last().locator('../..')
  await expect
    .poll(async () => {
      const text = (await renderedReply.textContent()) ?? ''
      return text.replace(/Speak|Copy|Regenerate/g, '').trim().length
    })
    .toBeGreaterThan(0)
  return renderedReply
}

test.beforeEach(async () => {
  test.setTimeout(300_000)
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-app025-model-download-'))
  ledgerPath = path.join(profileDir, 'network-ledger.jsonl')
  await launchApp()
})

// Playwright requires the first callback argument to use object destructuring.
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  await closeApp()
  if (fs.existsSync(ledgerPath)) {
    fs.copyFileSync(ledgerPath, testInfo.outputPath('app025-network-ledger.jsonl'))
  }
  fs.rmSync(profileDir, { recursive: true, force: true })
})

// Playwright requires the first callback argument to use object destructuring.
// eslint-disable-next-line no-empty-pattern
test('rejects corrupt download, verifies retry, activates, chats, and persists', async ({}, testInfo) => {
  test.setTimeout(300_000)
  await openModels()

  const card = targetCard()
  await expect(card).toBeVisible()
  await expect(card).toContainText('2.0GB')
  await expect(card).not.toContainText("Won't fit")
  await card.getByRole('button', { name: 'Download', exact: true }).click()

  // The staged response is delivered in visible increments. The card must render transfer
  // progress while bytes arrive rather than implying that the model is already usable.
  await expect.poll(() => cardShowsDownloadProgress(card), { timeout: 10_000 }).toBe(true)
  await expect(page.getByRole('button', { name: /^Storage/ })).toContainText('1✕', {
    timeout: 15_000
  })

  const finalPath = path.join(modelsDir(), TARGET_FILE)
  const partPath = `${finalPath}.part`
  expect(fs.existsSync(partPath)).toBe(true)
  const corruptPartBytes = fs.statSync(partPath).size
  expect(fs.existsSync(finalPath)).toBe(false)
  expect(fs.existsSync(path.join(modelsDir(), 'active-model.json'))).toBe(false)
  await expect(card.getByText('Active', { exact: true })).toHaveCount(0)
  await expect(card.getByRole('button', { name: 'Download', exact: true })).toBeVisible()

  // Retry is a real rendered recovery journey in Storage. The corrupt staging bytes remain visible
  // as failed work, but cannot appear in the installed group or be selected.
  await page.getByRole('button', { name: /^Storage/ }).click()
  const failedDownload = page.getByText(TARGET_ID, { exact: true }).locator('../..')
  await expect(failedDownload).toContainText('downloaded file is not a valid GGUF')
  await failedDownload.getByRole('button', { name: 'Retry' }).click()
  await expect.poll(sawIntermediateStorageProgress, { timeout: 15_000 }).toBe(true)

  const projectorPath = path.join(modelsDir(), TARGET_PROJECTOR)
  await expect
    .poll(() => fs.existsSync(finalPath) && fs.existsSync(projectorPath), { timeout: 90_000 })
    .toBe(true)
  await expect(page.getByText(TARGET_ID, { exact: true })).toHaveCount(0)
  await expect(page.getByText(TARGET_NAME, { exact: true }).last()).toBeVisible()
  expect(fs.existsSync(partPath)).toBe(false)
  expect(fs.statSync(finalPath).size).toBe(fs.statSync(SOURCE_MODEL).size)
  expect(fs.readFileSync(finalPath).subarray(0, 4).toString('ascii')).toBe('GGUF')
  expect(fs.statSync(projectorPath).size).toBe(fs.statSync(SOURCE_PROJECTOR).size)
  expect(fs.readFileSync(projectorPath).subarray(0, 4).toString('ascii')).toBe('GGUF')

  const audit = events()
  expect(audit).toContainEqual(
    expect.objectContaining({ event: 'model-response', attempt: 1, kind: 'corrupt' })
  )
  expect(audit).toContainEqual(
    expect.objectContaining({
      event: 'model-request',
      attempt: 2,
      range: `bytes=${corruptPartBytes}-`
    })
  )
  expect(audit).toContainEqual(
    expect.objectContaining({
      event: 'payload-complete',
      attempt: 2,
      bytes: fs.statSync(SOURCE_MODEL).size
    })
  )
  expect(audit).toContainEqual(
    expect.objectContaining({
      event: 'payload-complete',
      attempt: 3,
      bytes: fs.statSync(SOURCE_PROJECTOR).size
    })
  )

  await page.getByRole('button', { name: 'Text', exact: true }).click()
  const installedCard = targetCard()
  await expect(installedCard.getByRole('button', { name: 'Use', exact: true })).toBeVisible()
  await installedCard.getByRole('button', { name: 'Use', exact: true }).click()
  await expect(installedCard.getByText('Active', { exact: true })).toBeVisible()

  await enterChat()
  await expect(page.getByRole('button', { name: /Qwen 3\.5 2B/ })).toBeVisible()
  await sendPromptAndWaitForAssistant(CHAT_PROMPT)
  await testInfo.attach('app025-verified-model-chat', {
    body: await page.screenshot(),
    contentType: 'image/png'
  })

  await closeApp()
  await launchApp()
  await openModels()
  const relaunchedCard = targetCard()
  await expect(relaunchedCard.getByText('Active', { exact: true })).toBeVisible()
  expect(
    JSON.parse(fs.readFileSync(path.join(modelsDir(), 'active-model.json'), 'utf8'))
  ).toMatchObject({
    id: TARGET_ID,
    primary: TARGET_FILE
  })

  await enterChat()
  await expect(page.getByRole('button', { name: /Qwen 3\.5 2B/ })).toBeVisible()
  await sendPromptAndWaitForAssistant(RELAUNCH_PROMPT)
})
