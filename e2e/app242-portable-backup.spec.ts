/**
 * APP-242 — a portable backup restores a usable profile.
 *
 * The journey creates a project, indexes a real text file, chats through the
 * rendered UI, exports with the production backup engine, starts a separate
 * clean profile, restores through the rendered Settings UI, and retrieves a
 * fact from the restored source. Only OS file pickers and the native model
 * executable are controlled boundaries.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'

const PROJECT = 'Recovery Atlas'
const DOCUMENT = 'aurora-launch.txt'
const PROMPT = 'What is the Aurora launch passphrase? Answer exactly.'
const ANSWER = 'ORBIT-731'

let app: ElectronApplication | null = null
let page: Page
let rootDir: string
let backupPath: string
let knowledgePath: string

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

function installModelBoundary(profile: string): string {
  const modelsDir = path.join(profile, 'models')
  const binDir = path.join(profile, 'e2e-bin')
  const llamaDir = path.join(binDir, 'llama')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.mkdirSync(llamaDir, { recursive: true })

  const model = Buffer.alloc(2_048)
  model.write('GGUF')
  fs.writeFileSync(path.join(modelsDir, 'app242-local.gguf'), model)
  fs.writeFileSync(
    path.join(modelsDir, 'active-model.json'),
    JSON.stringify({ id: 'app242-local-model', primary: 'app242-local.gguf', mmproj: null })
  )

  const embeddingCache = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Off Grid AI Desktop',
    'models',
    '.cache',
    'Xenova'
  )
  if (!fs.existsSync(embeddingCache)) {
    throw new Error(`APP-242 requires the installed local embedding cache at ${embeddingCache}`)
  }
  const cacheParent = path.join(modelsDir, '.cache')
  fs.mkdirSync(cacheParent, { recursive: true })
  fs.symlinkSync(embeddingCache, path.join(cacheParent, 'Xenova'), 'dir')

  const executable = path.join(llamaDir, 'llama-server')
  fs.copyFileSync(
    path.join(process.cwd(), 'e2e', 'fixtures', 'app242-backup-rag-llama-server.mjs'),
    executable
  )
  fs.chmodSync(executable, 0o755)
  return binDir
}

async function launchProfile(profile: string): Promise<void> {
  const binDir = installModelBoundary(profile)
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profile,
      OFFGRID_BIN_DIR: binDir,
      OFFGRID_PRO: '0',
      NODE_ENV: 'production',
      NO_PROXY: '127.0.0.1,localhost'
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)
}

async function chooseOpenPath(filePath: string): Promise<void> {
  if (!app) throw new Error('Electron app is not running')
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  }, filePath)
}

async function chooseSavePath(filePath: string): Promise<void> {
  if (!app) throw new Error('Electron app is not running')
  await app.evaluate(({ dialog }, selected) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: selected })
  }, filePath)
}

async function openSidebarScreen(name: 'Projects' | 'Settings'): Promise<void> {
  const control = page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name, exact: true })
  await expect(control).toBeVisible()
  await control.click()
}

async function openBackupSettings(): Promise<void> {
  await openSidebarScreen('Settings')
  const card = page.getByText('Backup & restore', { exact: true }).first()
  await expect(card).toBeVisible()
  await card.click()
  await expect(page).toHaveURL(/\/settings\/backup$/)
  await expect(page.getByRole('button', { name: 'Create backup' })).toBeVisible()
}

async function createProjectWithKnowledge(): Promise<void> {
  await openSidebarScreen('Projects')
  await page.getByTitle('New project').click()
  await page.getByPlaceholder('Project name…').fill(PROJECT)
  await page.keyboard.press('Enter')
  await expect(page.getByText(PROJECT, { exact: true }).first()).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Knowledge & settings', exact: true })
  ).toBeVisible()

  await chooseOpenPath(knowledgePath)
  await page.getByRole('button', { name: 'Add files', exact: true }).click()
  await expect(page.getByText(`${DOCUMENT}: indexed`, { exact: true })).toBeVisible({
    timeout: 60_000
  })
  await expect(page.getByText(DOCUMENT, { exact: true })).toBeVisible()
}

async function askProjectQuestion(): Promise<void> {
  await page.getByRole('button', { name: 'Chats', exact: true }).click()
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  const composer = page.getByRole('textbox', { name: /Ask (anything|about)/i })
  await expect(composer).toBeVisible()
  await composer.fill(PROMPT)
  await page.keyboard.press('Enter')
  await expect(page.getByText(PROMPT, { exact: true }).last()).toBeVisible()
  await expect(page.getByText(ANSWER, { exact: true }).last()).toBeVisible({ timeout: 30_000 })
}

test.describe('APP-242 portable backup', () => {
  test.skip(targetIsPackaged(), 'This native-boundary fixture is for the source-built E2E target.')
  test.describe.configure({ mode: 'serial', timeout: 180_000 })

  test.beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-app242-'))
    backupPath = path.join(rootDir, 'portable-profile.zip')
    knowledgePath = path.join(rootDir, DOCUMENT)
    fs.writeFileSync(knowledgePath, 'The Aurora launch passphrase is ORBIT-731.\n')
  })

  test.afterEach(async () => {
    await closeApp()
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  // Playwright requires the first callback argument to use object destructuring.
  // eslint-disable-next-line no-empty-pattern
  test('restores chats, projects, and retrievable knowledge into a clean profile', async ({}, testInfo) => {
    const sourceProfile = path.join(rootDir, 'source-profile')
    await launchProfile(sourceProfile)
    await createProjectWithKnowledge()
    await askProjectQuestion()

    await openBackupSettings()
    await chooseSavePath(backupPath)
    await page.getByRole('button', { name: 'Create backup' }).click()
    await expect(page.getByRole('status')).toContainText('Backup saved')
    expect(fs.statSync(backupPath).size).toBeGreaterThan(0)
    await closeApp()

    const restoredProfile = path.join(rootDir, 'restored-profile')
    await launchProfile(restoredProfile)
    await openBackupSettings()
    await chooseOpenPath(backupPath)
    await page.getByRole('button', { name: 'Choose backup' }).click()
    await expect(page.getByRole('status')).toContainText(
      'Restored 1 project, 1 chat, 2 messages, and 1 document.'
    )

    await openSidebarScreen('Projects')
    await page.getByText(PROJECT, { exact: true }).first().click()
    await page.getByRole('button', { name: 'Knowledge & settings', exact: true }).click()
    await expect(page.getByText(DOCUMENT, { exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Chats', exact: true }).click()
    await expect(page.getByText('1 chat', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'New chat', exact: true }).click()
    const composer = page.getByRole('textbox', { name: /Ask (anything|about)/i })
    await composer.fill(PROMPT)
    await page.keyboard.press('Enter')
    await expect(page.getByText(ANSWER, { exact: true }).last()).toBeVisible({ timeout: 30_000 })

    await page.screenshot({ path: testInfo.outputPath('app242-restored-project-chat.png') })
  })
})
