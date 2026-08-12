/**
 * APP-068 — project knowledge stays isolated.
 *
 * The journey creates two projects through the rendered UI, indexes a distinct
 * real text document into each through the production ingestion/RAG stack, and
 * asks both an own-project and cross-project question from fresh project chats.
 * Own-project retrieval must work, preventing a blanket refusal from making the
 * isolation checks pass. Only the OS file picker and native llama executable are
 * controlled boundaries.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'

const ALPHA = {
  project: 'Celestial Atlas',
  document: 'celestial-identifier.txt',
  fact: 'COMET-ALPHA-417',
  ownQuestion: 'What is the celestial identifier in this project knowledge? Answer exactly.',
  crossQuestion: 'What is the marine identifier in this project knowledge? Answer exactly.'
}

const BETA = {
  project: 'Marine Atlas',
  document: 'marine-identifier.txt',
  fact: 'TIDE-BETA-928',
  ownQuestion: 'What is the marine identifier in this project knowledge? Answer exactly.',
  crossQuestion: 'What is the celestial identifier in this project knowledge? Answer exactly.'
}

const NOT_FOUND = 'That identifier is not present in this project knowledge.'

let app: ElectronApplication | null = null
let page: Page
let rootDir: string
let profileDir: string

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
  fs.writeFileSync(path.join(modelsDir, 'app068-project-isolation.gguf'), model)
  fs.writeFileSync(
    path.join(modelsDir, 'active-model.json'),
    JSON.stringify({
      id: 'app068-project-isolation',
      primary: 'app068-project-isolation.gguf',
      mmproj: null
    })
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
    throw new Error(`APP-068 requires the installed local embedding cache at ${embeddingCache}`)
  }
  const cacheParent = path.join(modelsDir, '.cache')
  fs.mkdirSync(cacheParent, { recursive: true })
  fs.symlinkSync(embeddingCache, path.join(cacheParent, 'Xenova'), 'dir')

  const executable = path.join(llamaDir, 'llama-server')
  fs.copyFileSync(
    path.join(process.cwd(), 'e2e', 'fixtures', 'app068-project-isolation-llama-server.mjs'),
    executable
  )
  fs.chmodSync(executable, 0o755)
  return binDir
}

async function chooseFile(filePath: string): Promise<void> {
  if (!app) throw new Error('Electron app is not running')
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  }, filePath)
}

async function openProjects(): Promise<void> {
  const projects = page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name: 'Projects', exact: true })
  await expect(projects).toBeVisible()
  await projects.click()
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible()
}

async function createProject(project: string, document: string, content: string): Promise<void> {
  await openProjects()
  await page.getByTitle('New project').click()
  await page.getByPlaceholder('Project name…').fill(project)
  await page.keyboard.press('Enter')
  await expect(page.getByText(project, { exact: true }).first()).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Knowledge & settings', exact: true })
  ).toBeVisible()

  const filePath = path.join(rootDir, document)
  fs.writeFileSync(filePath, content)
  await chooseFile(filePath)
  await page.getByRole('button', { name: 'Add files', exact: true }).click()
  await expect(page.getByText(`${document}: indexed`, { exact: true })).toBeVisible({
    timeout: 60_000
  })
  await expect(page.getByText(document, { exact: true })).toBeVisible()
}

async function startFreshProjectChat(project: string): Promise<void> {
  await openProjects()
  await page.getByText(project, { exact: true }).first().click()
  await page.getByRole('button', { name: 'Chats', exact: true }).click()
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await expect(page.getByRole('textbox', { name: /Ask about/i })).toBeVisible()
}

async function ask(question: string): Promise<void> {
  const composer = page.getByRole('textbox', { name: /Ask about/i })
  await composer.fill(question)
  await page.keyboard.press('Enter')
  await expect(page.getByText(question, { exact: true }).last()).toBeVisible()
}

async function expectAnswer(answer: string): Promise<void> {
  await expect(page.getByText(answer, { exact: true }).last()).toBeVisible({ timeout: 30_000 })
}

test.describe('APP-068 project knowledge isolation', () => {
  test.skip(targetIsPackaged(), 'This native-boundary fixture is for the source-built E2E target.')
  test.describe.configure({ mode: 'serial', timeout: 180_000 })

  test.beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-app068-'))
    profileDir = path.join(rootDir, 'profile')
    const binDir = installModelBoundary(profileDir)
    app = await launchOffGrid({
      env: {
        ...process.env,
        OFFGRID_USER_DATA: profileDir,
        OFFGRID_BIN_DIR: binDir,
        OFFGRID_PRO: '0',
        NODE_ENV: 'production',
        NO_PROXY: '127.0.0.1,localhost'
      }
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await completeOnboarding(page)
  })

  test.afterEach(async () => {
    await closeApp()
    if (path.basename(rootDir).startsWith('offgrid-app068-')) {
      fs.rmSync(rootDir, { recursive: true, force: true })
    }
  })

  // Playwright requires the first callback argument to use object destructuring.
  // eslint-disable-next-line no-empty-pattern
  test('retrieves each own-project fact while preventing both cross-project reads', async ({}, testInfo) => {
    await createProject(
      ALPHA.project,
      ALPHA.document,
      `The celestial identifier for this project is ${ALPHA.fact}.\n`
    )
    await createProject(
      BETA.project,
      BETA.document,
      `The marine identifier for this project is ${BETA.fact}.\n`
    )

    await startFreshProjectChat(ALPHA.project)
    await ask(ALPHA.ownQuestion)
    await expectAnswer(ALPHA.fact)
    await page.screenshot({
      path: testInfo.outputPath('app068-own-project-retrieval.png'),
      fullPage: true
    })

    await startFreshProjectChat(ALPHA.project)
    await ask(ALPHA.crossQuestion)
    await expectAnswer(NOT_FOUND)

    await startFreshProjectChat(BETA.project)
    await ask(BETA.ownQuestion)
    await expectAnswer(BETA.fact)

    await startFreshProjectChat(BETA.project)
    await ask(BETA.crossQuestion)
    await expectAnswer(NOT_FOUND)

    await page.screenshot({
      path: testInfo.outputPath('app068-cross-project-isolation.png'),
      fullPage: true
    })
  })
})
