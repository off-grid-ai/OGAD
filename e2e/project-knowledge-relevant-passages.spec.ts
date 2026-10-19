/**
 * Settings → Text → Answers → Project knowledge: how much of a project's knowledge base each
 * answer reads.
 *
 * Real app, real document engine and ranking (with the installed local embedding model); the
 * only boundaries are the OS file picker and a fake llama-server that records every request and
 * searches the knowledge base only when a question needs it. A project holds twelve small
 * documents, one per station.
 *
 * When needed (the default): no document goes into the prompt, so a question that does not need
 * them is not slowed by them; a question about a station searches and answers from the result.
 * Every answer: all twelve go in. Relevant passages: the matching document, and no more than the
 * eight best passages.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'

const PROJECT = 'Lighthouse archive'
const STATIONS = [
  'quokka',
  'heron',
  'walrus',
  'otter',
  'puffin',
  'gannet',
  'plover',
  'curlew',
  'tern',
  'osprey',
  'kittiwake',
  'cormorant'
]
const codeword = (station: string): string => `${station.toUpperCase()}-${station.length * 7}`
const QUESTION = 'What is the keeper codeword for the quokka station?'
const UNRELATED = 'What is a good name for a lighthouse cat?'

let app: ElectronApplication | null = null
let page: Page
let rootDir: string
let profileDir: string
let modelLog: string

async function closeApp(): Promise<void> {
  const running = app
  if (!running) return
  app = null
  const child: ChildProcess = running.process()
  await running.close()
  if (child.exitCode === null)
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))
}

function installModelBoundary(): string {
  const modelsDir = path.join(profileDir, 'models')
  const binDir = path.join(profileDir, 'e2e-bin')
  const llamaDir = path.join(binDir, 'llama')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.mkdirSync(llamaDir, { recursive: true })
  const model = Buffer.alloc(2_048)
  model.write('GGUF')
  fs.writeFileSync(path.join(modelsDir, 'relevant-passages.gguf'), model)
  fs.writeFileSync(
    path.join(modelsDir, 'active-model.json'),
    JSON.stringify({ id: 'relevant-passages', primary: 'relevant-passages.gguf', mmproj: null })
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
  // The real local embedder runs (no fake of our own retrieval). With this machine's embedding
  // cache present it is linked in, so the run starts at once; on a clean runner the app downloads
  // the embedder itself on first use (free, no key), as it does for a new user.
  if (fs.existsSync(embeddingCache)) {
    fs.mkdirSync(path.join(modelsDir, '.cache'), { recursive: true })
    fs.symlinkSync(embeddingCache, path.join(modelsDir, '.cache', 'Xenova'), 'dir')
  }
  // Records every request (OFFGRID_KNOWLEDGE_MODEL_LOG); searches only for a codeword question.
  const executable = path.join(llamaDir, 'llama-server')
  fs.copyFileSync(path.resolve('e2e/fixtures/knowledge-search-llama-server.mjs'), executable)
  fs.chmodSync(executable, 0o755)
  return binDir
}

/** The first request of each turn that asked `question` (not a tool round, not a suggestion). */
function turnsAsking(question: string): string[] {
  if (!fs.existsSync(modelLog)) return []
  return fs
    .readFileSync(modelLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .filter((line) => {
      const request = JSON.parse(line) as { messages?: { role: string; content: unknown }[] }
      const messages = request.messages ?? []
      const users = messages.filter((message) => message.role === 'user')
      const last = JSON.stringify(users[users.length - 1]?.content ?? '')
      return (
        last.includes(question) &&
        !last.includes('The user asked:') &&
        !messages.some((message) => message.role === 'tool')
      )
    })
}

/** The codewords that reached the model before it searched, in the `turn`-th turn asking it. */
async function codewordsSentFor(turn: number, question = QUESTION): Promise<string[]> {
  await expect
    .poll(() => turnsAsking(question).length, { timeout: 60_000 })
    .toBeGreaterThanOrEqual(turn)
  const sent = turnsAsking(question)[turn - 1]!
  return STATIONS.map(codeword).filter((word) => sent.includes(word))
}

async function openProject(): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name: 'Projects', exact: true })
    .click()
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible()
}

async function askInNewProjectChat(question = QUESTION): Promise<void> {
  await openProject()
  await page.getByText(PROJECT, { exact: true }).first().click()
  await page.getByRole('radio', { name: 'Chats', exact: true }).click()
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  await expect(composer).toHaveAttribute('placeholder', /Ask about/i)
  await composer.fill(question)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toBeHidden({
    timeout: 60_000
  })
}

test.describe('Project knowledge: relevant passages', () => {
  test.skip(targetIsPackaged(), 'This native-boundary fixture is for the source-built E2E target.')
  test.describe.configure({ timeout: 240_000 })

  test.beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-relevant-passages-'))
    profileDir = path.join(rootDir, 'profile')
    modelLog = path.join(profileDir, 'model-requests.jsonl')
    const binDir = installModelBoundary()
    app = await launchOffGrid({
      env: {
        ...process.env,
        OFFGRID_USER_DATA: profileDir,
        OFFGRID_BIN_DIR: binDir,
        OFFGRID_KNOWLEDGE_MODEL_LOG: modelLog,
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
    if (fs.existsSync(modelLog))
      await test.info().attach('model-requests.jsonl', { path: modelLog })
    await closeApp()
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  test('When needed reads the knowledge base only for a question that needs it; the other modes read it every time', async () => {
    // A project with twelve documents, one per station.
    await openProject()
    await page.getByTitle('New project').click()
    await page.getByPlaceholder('Project name…').fill(PROJECT)
    await page.keyboard.press('Enter')
    await expect(
      page.getByRole('radio', { name: 'Knowledge & settings', exact: true })
    ).toBeVisible()
    const files = STATIONS.map((station) => {
      const file = path.join(rootDir, `${station}-station.txt`)
      fs.writeFileSync(
        file,
        `Station log for the ${station} lighthouse.\nThe keeper codeword for the ${station} station is ${codeword(station)}.\n`
      )
      return file
    })
    await app!.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: selected })
    }, files)
    await page.getByRole('button', { name: 'Add files', exact: true }).click()
    for (const station of STATIONS) {
      await expect(page.getByText(`${station}-station.txt`, { exact: true })).toHaveCount(1, {
        timeout: 60_000
      })
    }
    await expect(page.getByRole('progressbar', { name: /^Indexing / })).toHaveCount(0, {
      timeout: 120_000
    })

    // When needed (the default): a question that does not need the documents reads none of them.
    await askInNewProjectChat(UNRELATED)
    expect(await codewordsSentFor(1, UNRELATED)).toEqual([])
    await expect(page.getByText('Plain answer.').first()).toBeVisible()
    // A question that needs them searches, and is answered from what the search found.
    await askInNewProjectChat()
    expect(await codewordsSentFor(1)).toEqual([])
    await expect(page.getByText(`The codeword is ${codeword('quokka')}.`).first()).toBeVisible({
      timeout: 30_000
    })

    // Settings → Text → Answers → Project knowledge.
    const chooseMode = async (label: string): Promise<void> => {
      await page.getByRole('button', { name: 'Chat', exact: true }).click()
      await page.getByRole('button', { name: 'Active models' }).click()
      await page.getByRole('button', { name: 'Settings', exact: true }).last().click()
      const mode = page.getByRole('radiogroup', { name: 'Project knowledge' })
      await mode.getByRole('radio', { name: label }).click()
      await expect(mode.getByRole('radio', { name: label })).toBeChecked()
      await page.keyboard.press('Escape')
    }
    const mode = page.getByRole('radiogroup', { name: 'Project knowledge' })
    await page.getByRole('button', { name: 'Chat', exact: true }).click()
    await page.getByRole('button', { name: 'Active models' }).click()
    await page.getByRole('button', { name: 'Settings', exact: true }).last().click()
    await expect(mode.getByRole('radio', { name: 'When needed' })).toBeChecked()
    await page.keyboard.press('Escape')

    // Every answer reads the whole knowledge base: all twelve documents go in.
    await chooseMode('Every answer')
    await askInNewProjectChat()
    expect(await codewordsSentFor(2)).toHaveLength(STATIONS.length)

    await chooseMode('Relevant passages')

    // The same question in a new chat: the quokka document goes in, and only the best passages.
    await askInNewProjectChat()
    const relevant = await codewordsSentFor(3)
    expect(relevant).toContain(codeword('quokka'))
    expect(relevant.length).toBeLessThanOrEqual(8)
  })
})
