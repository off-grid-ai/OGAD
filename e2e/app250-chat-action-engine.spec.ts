/**
 * APP-250 — the R1 golden path: a chat ask becomes a durable, verified action.
 *
 * The rendered app, tool loop, tool-call parsing, the @offgrid/use engine
 * (queue, gate, semantic rail, read-back verification), IPC, and MemoryChat
 * are production code. Two fakes stand at the true boundaries: a scripted
 * llama-server (emits the tool call as text, the way small local models do)
 * and a scripted actions helper (records creates, answers list read-backs).
 *
 * Proves, on a fresh profile with Tools enabled through the real composer
 * menu (default-off until R2's per-turn router; see checklist 18b):
 * chat ask -> tool call -> durable Action -> semantic rail create ->
 * read-back verify -> confirmed in chat. The helper log pins the order:
 * exactly one create, then a list (the read-back actually ran).
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'

let app: ElectronApplication | null = null
let page: Page
let profileDir: string
let helperLog: string

function stageWorld(): void {
  // The model boundary: a stub gguf + the scripted server as llama-server.
  const modelsDir = path.join(profileDir, 'models')
  const llamaDir = path.join(profileDir, 'bin', 'llama')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.mkdirSync(llamaDir, { recursive: true })
  const gguf = Buffer.alloc(2_048)
  gguf.write('GGUF')
  fs.writeFileSync(path.join(modelsDir, 'app250-local.gguf'), gguf)
  fs.writeFileSync(
    path.join(modelsDir, 'active-model.json'),
    JSON.stringify({ id: 'app250-local-model', primary: 'app250-local.gguf', mmproj: null })
  )
  fs.copyFileSync(
    path.join(process.cwd(), 'e2e', 'fixtures', 'app250-actions-llama-server.mjs'),
    path.join(llamaDir, 'llama-server')
  )
  fs.chmodSync(path.join(llamaDir, 'llama-server'), 0o755)

  // The OS boundary: the scripted helper where dev resolution looks first
  // (cwd/scripts/actions-helper/actions-helper - the spec launches the app
  // with cwd pointed at the profile dir).
  const helperDir = path.join(profileDir, 'scripts', 'actions-helper')
  fs.mkdirSync(helperDir, { recursive: true })
  fs.copyFileSync(
    path.join(process.cwd(), 'e2e', 'fixtures', 'app250-actions-helper.mjs'),
    path.join(helperDir, 'actions-helper')
  )
  fs.chmodSync(path.join(helperDir, 'actions-helper'), 0o755)
}

const helperCalls = (): Array<{ command: string; args: Record<string, unknown> }> => {
  if (!fs.existsSync(helperLog)) {
    return []
  }
  return fs
    .readFileSync(helperLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test.beforeEach(async () => {
  test.skip(targetIsPackaged(), 'dev-target journey: the packaged app resolves its helper from Resources')
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-app250-'))
  helperLog = path.join(profileDir, 'helper-log.jsonl')
  stageWorld()
  app = await launchOffGrid({
    cwd: profileDir,
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profileDir,
      OFFGRID_BIN_DIR: path.join(profileDir, 'bin'),
      OFFGRID_APP250_HELPER_LOG: helperLog,
      OFFGRID_PRO: '0',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)
})

test.afterEach(async () => {
  const running = app
  app = null
  if (running) {
    await running.close()
  }
  fs.rmSync(profileDir, { recursive: true, force: true })
})

test('a chat ask becomes a created, read-back-verified reminder', async () => {
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  const composer = page.getByPlaceholder(/ask anything/i)
  await expect(composer).toBeVisible()
  const captureDismiss = page.getByRole('button', { name: 'Dismiss', exact: true })
  if (await captureDismiss.isVisible().catch(() => false)) {
    await captureDismiss.click()
  }

  // Enable Tools the way a user does: the composer's + menu.
  await page.getByRole('button', { name: 'Composer options' }).click()
  await page.getByRole('menuitem', { name: /^Tools/ }).click()
  await page.keyboard.press('Escape')

  await composer.fill('remind me to send the deck at 6pm today')
  await composer.press('Enter')

  // The model's confirmation only streams on the SECOND turn - after the
  // tool ran through the engine and reported its verified outcome.
  // .last(): the conversation rail previews the same text; the transcript
  // copy is the one that matters.
  await expect(page.getByText('Done - the reminder is set for 6pm today.').last()).toBeVisible({
    timeout: 90_000
  })

  // The tool activity row shows the engine's verified outcome, not a guess.
  await expect(page.getByText('reminders_create → Created the reminder.')).toBeVisible()

  // The helper log pins the guarantee: exactly one create, and at least one
  // list AFTER it - the read-back verification actually observed the world.
  const calls = helperCalls()
  const creates = calls.filter((c) => c.command === 'reminders.create')
  expect(creates).toHaveLength(1)
  expect(creates[0]?.args.title).toBe('Send the deck')
  const createIndex = calls.findIndex((c) => c.command === 'reminders.create')
  const listAfter = calls.slice(createIndex + 1).some((c) => c.command === 'reminders.list')
  expect(listAfter).toBe(true)

  await page.screenshot({ path: 'e2e/screenshots/r1-chat-action-verified.png' })
})
