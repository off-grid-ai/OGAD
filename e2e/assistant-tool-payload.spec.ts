import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'

let app: ElectronApplication | null = null
let page: Page
let profileDir: string
let auditFile: string

const offeredTools = (): string[][] =>
  fs.existsSync(auditFile)
    ? fs
        .readFileSync(auditFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event: string; tools?: string[] })
        .filter((entry) => entry.event === 'completion')
        .map((entry) => entry.tools ?? [])
    : []

test.beforeEach(async () => {
  test.skip(targetIsPackaged(), 'This test uses a local model boundary in the dev build')
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-assistant-tools-'))
  auditFile = path.join(profileDir, 'model-requests.jsonl')
  const modelsDir = path.join(profileDir, 'models')
  const llamaDir = path.join(profileDir, 'bin', 'llama')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.mkdirSync(llamaDir, { recursive: true })
  const model = Buffer.alloc(2_048)
  model.write('GGUF')
  fs.writeFileSync(path.join(modelsDir, 'assistant-tools.gguf'), model)
  fs.writeFileSync(
    path.join(modelsDir, 'active-model.json'),
    JSON.stringify({ id: 'assistant-tools-model', primary: 'assistant-tools.gguf', mmproj: null })
  )
  // Routing to pertinent tools needs MiniLM; reuse the installed embedding cache the way the
  // retrieval journeys do, so this turn is ranked rather than sent every tool while it downloads.
  const embeddingCache = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Off Grid AI Desktop',
    'models',
    '.cache',
    'Xenova'
  )
  test.skip(
    !fs.existsSync(embeddingCache),
    `This journey requires the installed local embedding cache at ${embeddingCache}`
  )
  fs.mkdirSync(path.join(modelsDir, '.cache'), { recursive: true })
  fs.symlinkSync(embeddingCache, path.join(modelsDir, '.cache', 'Xenova'), 'dir')
  const executable = path.join(llamaDir, 'llama-server')
  fs.copyFileSync(
    path.join(process.cwd(), 'e2e/fixtures/app045-streaming-llama-server.mjs'),
    executable
  )
  fs.chmodSync(executable, 0o755)

  app = await launchOffGrid({
    cwd: profileDir,
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profileDir,
      OFFGRID_BIN_DIR: path.join(profileDir, 'bin'),
      OFFGRID_PRO: '1',
      OFFGRID_E2E_HEADLESS: '1',
      OFFGRID_E2E_PRO_TASKS: '1',
      OFFGRID_E2E_ISOLATED_INSTANCE: '1',
      OFFGRID_APP045_AUDIT_FILE: auditFile,
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)
})

test.afterEach(async () => {
  await app?.close()
  fs.rmSync(profileDir, { recursive: true, force: true })
})

test('God sends only tools pertinent to the message', async () => {
  await page.keyboard.press('Meta+K')
  const palette = page.getByRole('dialog', { name: 'Search Off Grid AI' })
  await expect(palette).toBeVisible()
  await palette.getByPlaceholder(/^Search everything/).fill('Chat')
  await page.getByTestId('palette-screen-memory-chat-root').click()
  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  await expect(composer).toBeVisible()
  const captureDismiss = page.getByRole('button', { name: 'Dismiss', exact: true })
  if (await captureDismiss.isVisible().catch(() => false)) await captureDismiss.click()

  // The assistant is God now. God shows the answer, not how it was made, so the tool list is read
  // where it matters: the request the local model received.
  const assistant = page
    .getByTestId('chat-composer')
    .getByRole('button', { name: 'God', exact: true })
  await assistant.click()
  await expect(assistant).toHaveAttribute('aria-pressed', 'true')
  await composer.fill('What meetings do I have tomorrow?')
  await composer.press('Enter')

  await expect.poll(() => offeredTools().length, { timeout: 30_000 }).toBeGreaterThan(0)
  const tools = offeredTools()[0]
  expect(tools).toContain('search_meetings')
  expect(tools).not.toContain('get_datetime')
  // God may always act, so its acting tools ride along on every turn by design
  // (src/main/tools/chat-tool-selection.ts); the rest are routed by the message.
  expect(tools).toEqual(expect.arrayContaining(['web_use', 'computer_use']))
})
