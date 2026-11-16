/**
 * Ask about Off Grid AI (What it does for you): a question is answered by the chat model, a failed
 * ask says so and offers Try again, a question after a failure still gets its answer, and with no
 * chat model the pane says why and opens Models.
 *
 * The only fake is the native llama-server executable (e2e/fixtures/guide-ask-llama-server.mjs).
 * Like a model whose chat template enforces it, it refuses two user turns in a row, and it records
 * the role order of every request the app sends. Navigation, preload, IPC, the chat queue and the
 * renderer are the app's own.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid } from './helpers/launch'

let app: ElectronApplication | null = null
let page: Page
let userDataDir: string
let binDir: string

function installChatModel(): void {
  const modelsDir = path.join(userDataDir, 'models')
  const llamaDir = path.join(binDir, 'llama')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.mkdirSync(llamaDir, { recursive: true })
  const model = Buffer.alloc(2_048)
  model.write('GGUF')
  fs.writeFileSync(path.join(modelsDir, 'guide.gguf'), model)
  fs.writeFileSync(
    path.join(modelsDir, 'active-model.json'),
    JSON.stringify({ id: 'guide-model', primary: 'guide.gguf', mmproj: null })
  )
  const executable = path.join(llamaDir, 'llama-server')
  fs.copyFileSync(path.join(process.cwd(), 'e2e/fixtures/guide-ask-llama-server.mjs'), executable)
  fs.chmodSync(executable, 0o755)
}

/** The role order of every request the app sent the model. */
function sentRoles(): string[][] {
  const file = path.join(binDir, 'llama', 'requests.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { roles: string[] }).roles)
}

async function openAsk(): Promise<void> {
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_BIN_DIR: binDir,
      OFFGRID_PRO: '0',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)
  await page.getByRole('button', { name: 'What it does for you', exact: true }).first().click()
  await expect(page.getByRole('region', { name: 'Ask about Off Grid AI' })).toBeVisible()
}

async function ask(question: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Your question' }).fill(question)
  await page.getByRole('button', { name: 'Ask', exact: true }).click()
}

test.beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-guide-ask-'))
  binDir = path.join(userDataDir, 'bin')
})

test.afterEach(async () => {
  await app?.close()
  app = null
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

test('a question is answered; after a failed ask, Try again and the next question still work', async () => {
  test.setTimeout(120_000)
  installChatModel()
  await openAsk()
  const pane = page.getByRole('region', { name: 'Ask about Off Grid AI' })

  await ask('Does it work offline?')
  await expect(pane.getByText('You asked: Does it work offline?', { exact: false })).toBeVisible({
    timeout: 30_000
  })
  // Sent, the box is empty and ready for the next question.
  await expect(page.getByRole('textbox', { name: 'Your question' })).toHaveValue('')

  await ask('Please drop this one')
  await expect(pane.getByText('No answer came back.')).toBeVisible({ timeout: 30_000 })
  await expect(pane.getByText('Please drop this one', { exact: true })).toHaveCount(1)

  // Try again resends the same question without a second copy on screen.
  await pane.getByRole('button', { name: 'Try again' }).click()
  await expect(pane.getByText('No answer came back.')).toBeVisible({ timeout: 30_000 })
  await expect(pane.getByText('Please drop this one', { exact: true })).toHaveCount(1)

  // A new question after the failure is answered: the unanswered one stays on screen but is not
  // sent, so a model that needs alternating turns still answers.
  await ask('Can I use it on my phone?')
  await expect(
    pane.getByText('You asked: Can I use it on my phone?', { exact: false })
  ).toBeVisible({ timeout: 30_000 })
  await expect(pane.getByText('No answer came back.')).toHaveCount(0)
  await expect(pane.getByText('Please drop this one', { exact: true })).toHaveCount(1)

  const last = sentRoles().at(-1)!
  expect(last).toEqual(['system', 'user', 'assistant', 'user'])
})

test('with no chat model the pane says why and opens Models', async () => {
  test.setTimeout(120_000)
  await openAsk()
  const pane = page.getByRole('region', { name: 'Ask about Off Grid AI' })

  await ask('What can it do?')
  await expect(pane.getByText('No chat model yet. Load one, then ask again.')).toBeVisible({
    timeout: 30_000
  })
  await pane.getByRole('button', { name: 'Open Models' }).click()
  await expect(page.getByRole('region', { name: 'Ask about Off Grid AI' })).toHaveCount(0)
  expect(sentRoles()).toEqual([])
})
