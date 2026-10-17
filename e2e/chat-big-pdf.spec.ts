/**
 * A big PDF attached to a chat is answered from the right page, and cited by it.
 *
 * Real app, real document engine and ranking (with the installed local embedding model); the
 * boundaries are the OS file chooser and a fake llama-server that answers from whichever source
 * in its prompt holds the fact, citing that source's tag. A 260-page PDF is attached in the
 * composer; one fact is on page 250 only.
 *
 * Asserts: the model request for the question and for a follow-up carries the page-250 passage;
 * the answer shows a "p. 250" citation that opens the PDF at page 250; leaving the file out in the
 * Documents popover removes it from the next request; "Context is full." never shows.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import { textPdf } from './helpers/text-pdf'
import { closeAndWait, mainWindow } from './helpers/windows'

const FILE = 'harbour-ledger.pdf'
const PAGES = 260
const FACT_PAGE = 250
const FACT = 'ORCHID-7741'
const EMBEDDING_CACHE = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Off Grid AI Desktop',
  'models',
  '.cache',
  'Xenova'
)

let app: ElectronApplication | null = null
let page: Page
let profileDir: string
let modelLog: string
let pdfPath: string

/** The chat requests that carry `question` as the newest user turn (not follow-up suggestions). */
const requestsFor = (question: string): string[] =>
  (fs.existsSync(modelLog) ? fs.readFileSync(modelLog, 'utf8').split('\n') : [])
    .filter(Boolean)
    .filter((line) => {
      const body = JSON.parse(line) as { messages?: { role: string; content: unknown }[] }
      const users = (body.messages ?? []).filter((message) => message.role === 'user')
      const last = JSON.stringify(users[users.length - 1]?.content ?? '')
      return last.includes(question) && !last.includes('The user asked:')
    })

const ask = async (question: string): Promise<string> => {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  await composer.fill(question)
  await composer.press('Enter')
  await expect.poll(() => requestsFor(question).length, { timeout: 120_000 }).toBeGreaterThan(0)
  await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toBeHidden({
    timeout: 60_000
  })
  await expect(page.getByText('Context is full.', { exact: false })).toHaveCount(0)
  return requestsFor(question).at(-1)!
}

test.describe('A big PDF in chat', () => {
  test.skip(targetIsPackaged(), 'This native-model boundary is for the source-built E2E target.')

  test.beforeEach(async () => {
    test.skip(
      !fs.existsSync(EMBEDDING_CACHE),
      `needs the installed local embedding models at ${EMBEDDING_CACHE}`
    )
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-big-pdf-'))
    modelLog = path.join(profileDir, 'model-requests.jsonl')
    const modelsDir = path.join(profileDir, 'models')
    const llamaDir = path.join(profileDir, 'bin', 'llama')
    fs.mkdirSync(path.join(modelsDir, '.cache'), { recursive: true })
    fs.mkdirSync(llamaDir, { recursive: true })
    const gguf = Buffer.alloc(2_048)
    gguf.write('GGUF')
    fs.writeFileSync(path.join(modelsDir, 'document.gguf'), gguf)
    fs.writeFileSync(
      path.join(modelsDir, 'active-model.json'),
      JSON.stringify({ id: 'document-model', primary: 'document.gguf', mmproj: null })
    )
    fs.symlinkSync(EMBEDDING_CACHE, path.join(modelsDir, '.cache', 'Xenova'), 'dir')
    const executable = path.join(llamaDir, 'llama-server')
    fs.copyFileSync(path.resolve('e2e/fixtures/document-citation-llama-server.mjs'), executable)
    fs.chmodSync(executable, 0o755)

    pdfPath = path.join(profileDir, FILE)
    fs.writeFileSync(
      pdfPath,
      textPdf(
        Array.from({ length: PAGES }, (_, index) => {
          const number = index + 1
          const entry = `Harbour ledger page ${number}. Mooring ${number} was inspected, the tide table was copied, and the lantern oil was counted for berth ${number}.`
          return number === FACT_PAGE
            ? `${entry} The harbour safe code is ${FACT}, kept by the harbour master.`
            : `${entry} Nothing else of note was recorded.`
        })
      )
    )

    app = await launchOffGrid({
      env: {
        ...process.env,
        OFFGRID_USER_DATA: profileDir,
        OFFGRID_BIN_DIR: path.join(profileDir, 'bin'),
        OFFGRID_DOCUMENT_MODEL_LOG: modelLog,
        OFFGRID_PRO: '0',
        NODE_ENV: 'production',
        NO_PROXY: '127.0.0.1,localhost'
      }
    })
    page = await mainWindow(app)
    await completeOnboarding(page)
  })

  // Playwright requires the first callback argument to use object destructuring.
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    if (app) await closeAndWait(app)
    app = null
    if (modelLog && fs.existsSync(modelLog))
      fs.copyFileSync(modelLog, testInfo.outputPath('model-requests.jsonl'))
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true })
  })

  test('A 260-page PDF is answered from page 250, cited by page, and can be left out', async () => {
    test.setTimeout(300_000)
    await page.getByRole('button', { name: 'Chat', exact: true }).click()
    await page.getByRole('button', { name: 'Composer options', exact: true }).click()
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('menuitem', { name: 'Attach files', exact: true }).click()
    await (await chooser).setFiles(pdfPath)
    await expect(page.getByText(FILE).first()).toBeVisible()

    const question = 'What is the harbour safe code?'
    const first = await ask(question)
    expect(first).toContain(FACT)
    expect(first).toMatch(new RegExp(`page=\\\\"${FACT_PAGE}\\\\"`))

    // The answer cites the page, and the citation opens the PDF there.
    await expect(page.getByText(`The harbour safe code is ${FACT}`).first()).toBeVisible()
    const citation = page.getByRole('button', { name: `Open ${FILE}, p. ${FACT_PAGE}` }).first()
    await expect(citation).toBeVisible()
    await citation.click()
    await expect(page.getByText(`Page ${FACT_PAGE} of ${PAGES}`)).toBeVisible({ timeout: 30_000 })
    await page.keyboard.press('Escape')

    // A follow-up is still grounded in the same page: the document is not forgotten.
    const followUp = 'Repeat the harbour safe code, please.'
    expect(await ask(followUp)).toContain(FACT)

    // Left out of answers, the document no longer reaches the model.
    await page.getByRole('button', { name: '1 document in this chat', exact: true }).click()
    await page.getByRole('switch', { name: `Leave ${FILE} out of answers`, exact: true }).click()
    await expect(
      page.getByRole('switch', { name: `Use ${FILE} in answers`, exact: true })
    ).toBeVisible()
    await page.keyboard.press('Escape')
    const excluded = 'What is the harbour safe code now?'
    const last = await ask(excluded)
    // Earlier answers in the history still quote the code; no passage of the document is sent.
    expect(last).not.toContain('kept by the harbour master')
    expect(last).not.toContain('<source id=')
    await expect(page.getByText('The documents do not say.').first()).toBeVisible()
  })
})
