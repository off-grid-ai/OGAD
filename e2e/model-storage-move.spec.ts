/**
 * Choose a new folder for model files, in Settings → Setup & health → Storage.
 *
 * Real app over two boundaries: the OS folder picker and "Existing model files" question
 * (answered the way a person clicks them), and a fake llama-server that records the model path
 * each launch uses.
 *
 * Move files: the new folder is used at once and the model is copied there. After a restart the
 * active model starts from the new folder and still answers, the old copy is gone, and a file
 * Off Grid does not own stays where it was.
 *
 * Leave files: the new folder is used for downloads, the old one is kept as a folder to scan, and
 * the active model still starts from where it is.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import { gotoSettings, openSettingsSection } from './helpers/settings'
import { closeAndWait, mainWindow } from './helpers/windows'

const MODEL_FILE = 'storage-move.gguf'
const UNKNOWN_FILE = 'my-notes.txt'
const QUESTION = 'Do you still answer from the moved model?'
const ANSWER = 'The local engine answered.'

let app: ElectronApplication | null = null
let page: Page
let profileDir: string
let oldFolder: string
let newFolder: string
let modelLog: string

/** The model path each llama-server launch was given. */
const launchedModels = (): string[] =>
  fs.existsSync(modelLog)
    ? fs
        .readFileSync(modelLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event: string; args?: string[] })
        .filter((entry) => entry.event === 'launch')
        .map((entry) => {
          const args = entry.args ?? []
          const flag = Math.max(args.indexOf('-m'), args.indexOf('--model'))
          return flag >= 0 ? fs.realpathSync.native(path.dirname(args[flag + 1] ?? '')) : ''
        })
    : []

/** Chat requests the engine has answered. */
const chatRequests = (): number =>
  fs.existsSync(modelLog)
    ? fs
        .readFileSync(modelLog, 'utf8')
        .split('\n')
        .filter((line) => line.includes('"event":"chat"')).length
    : 0

const launch = async (): Promise<void> => {
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
}

/** The OS dialogs answer the way a person clicks them: this folder, then this button. */
const answerDialogs = async (folder: string, button: 'Move files' | 'Leave files'): Promise<void> =>
  app!.evaluate(
    ({ dialog }, answer) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [answer.folder]
      })) as never
      dialog.showMessageBox = (async (options: { buttons?: string[] }) => ({
        response: (options.buttons ?? []).indexOf(answer.button),
        checkboxChecked: false
      })) as never
    },
    { folder, button }
  )

const openStorage = async (): Promise<void> => {
  await gotoSettings(page)
  await openSettingsSection(page, 'Setup & health')
}

/** A chat is the model's first use: the engine starts for it (it never starts at launch). */
const askInChat = async (): Promise<void> => {
  const before = chatRequests()
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  await composer.fill(QUESTION)
  await composer.press('Enter')
  await expect.poll(chatRequests, { timeout: 60_000 }).toBeGreaterThan(before)
  await expect(page.getByText(ANSWER).first()).toBeVisible({ timeout: 30_000 })
}

test.describe('Model storage folder', () => {
  test.skip(targetIsPackaged(), 'This native-model boundary is for the source-built E2E target.')

  test.beforeEach(async () => {
    profileDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-storage-move-')))
    oldFolder = path.join(profileDir, 'models')
    newFolder = path.join(profileDir, 'New model folder')
    modelLog = path.join(profileDir, 'model-log.jsonl')
    fs.mkdirSync(oldFolder, { recursive: true })
    fs.mkdirSync(newFolder, { recursive: true })
    const model = Buffer.alloc(4_096)
    model.write('GGUF')
    fs.writeFileSync(path.join(oldFolder, MODEL_FILE), model)
    fs.writeFileSync(
      path.join(oldFolder, 'active-model.json'),
      JSON.stringify({ id: 'storage-move-model', primary: MODEL_FILE, mmproj: null })
    )
    fs.writeFileSync(path.join(oldFolder, UNKNOWN_FILE), 'not a model')
    const llamaDir = path.join(profileDir, 'bin', 'llama')
    fs.mkdirSync(llamaDir, { recursive: true })
    const executable = path.join(llamaDir, 'llama-server')
    fs.copyFileSync(path.resolve('e2e/fixtures/launch-log-llama-server.mjs'), executable)
    fs.chmodSync(executable, 0o755)
    // The model loads on its first use, never at launch; each test chats after its restart to
    // see which folder it starts from. A chat before the move would leave its background indexing
    // holding the download gate, which a move waits for.
    await launch()
  })

  // Playwright requires the first callback argument to use object destructuring.
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    if (app) await closeAndWait(app)
    app = null
    if (fs.existsSync(modelLog)) fs.copyFileSync(modelLog, testInfo.outputPath('model-log.jsonl'))
    fs.rmSync(profileDir, { recursive: true, force: true })
  })

  test('Move files uses the new folder, and after a restart the model runs from it', async () => {
    test.setTimeout(150_000)
    await openStorage()
    await expect(page.getByTitle(oldFolder, { exact: true })).toBeVisible()
    await answerDialogs(newFolder, 'Move files')
    await page.getByRole('button', { name: 'Choose folder', exact: true }).click()

    await expect(page.getByText(`New folder: ${newFolder}`, { exact: false })).toContainText(
      'The new folder is active. Old copies are removed after the next restart if verified. 1 unknown entries were left in place.'
    )
    await expect(page.getByTitle(newFolder, { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Restart now', exact: true })).toBeVisible()
    expect(fs.existsSync(path.join(newFolder, MODEL_FILE))).toBe(true)
    // Restarting the way the button does it relaunches outside the test's control, so the test
    // closes and opens the app itself.
    await closeAndWait(app!)
    const before = launchedModels().length
    await launch()

    await askInChat()
    expect(launchedModels().slice(before)).toContain(newFolder)
    await expect
      .poll(() => fs.existsSync(path.join(oldFolder, MODEL_FILE)), { timeout: 15_000 })
      .toBe(false)
    expect(fs.existsSync(path.join(oldFolder, UNKNOWN_FILE))).toBe(true)
    await openStorage()
    await expect(page.getByTitle(newFolder, { exact: true })).toBeVisible()
  })

  test('Leave files uses the new folder for downloads and keeps the model where it is', async () => {
    test.setTimeout(150_000)
    await openStorage()
    await answerDialogs(newFolder, 'Leave files')
    await page.getByRole('button', { name: 'Choose folder', exact: true }).click()

    await expect(page.getByText(`New folder: ${newFolder}`, { exact: false })).toContainText(
      'Restart to use it. Existing files stay in the current folder.'
    )
    expect(fs.existsSync(path.join(newFolder, MODEL_FILE))).toBe(false)
    await closeAndWait(app!)
    const before = launchedModels().length
    await launch()

    await askInChat()
    expect(launchedModels().slice(before)).toContain(oldFolder)
    expect(fs.existsSync(path.join(oldFolder, MODEL_FILE))).toBe(true)
    await openStorage()
    await expect(page.getByTitle(newFolder, { exact: true })).toBeVisible()
    await expect(
      page.getByRole('button', { name: `Remove ${oldFolder}`, exact: true })
    ).toBeVisible()
  })
})
