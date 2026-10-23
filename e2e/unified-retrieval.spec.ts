/**
 * Unified retrieval: one search engine for memory, chats and the search palette.
 *
 * The rendered app, chat storage, the search index (unicode61 FTS with the trigram twin for
 * scripts without spaces), the record search service, the search_memory tool, citation
 * numbering, the date line at the end of the system prompt, IPC and the chat UI are production
 * code. One fake stands at the true boundary: a scripted llama-server that repeats only what
 * reached it (e2e/fixtures/unified-retrieval-llama-server.mjs). Embeddings stay offline, so this
 * proves the keyword and trigram paths a fresh install has before its embedder is ready.
 *
 * Proves, on a fresh profile, from what the user sees:
 *  - a fact told in one chat is found from a new chat, cited as [S#], dated the day it was said,
 *    and the citation opens the chat it came from;
 *  - the chat knows today's date (it comes from the prompt's date line, not the model);
 *  - the search palette finds chat text by a typed prefix, a Hindi word, Japanese text (no
 *    spaces between words) and the time word "today".
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'

const PROMISE = 'Note for later: I promised Kunal the RBI filing by Friday.'
const ENGLISH = 'Quarterly compliance review with the audit team.'
const HINDI = 'कल की बैठक में बजट पर चर्चा हुई।'
const JAPANESE = '来週の会議は東京で行います。'

let app: ElectronApplication | null = null
let page: Page
let rootDir: string
let modelLog: string

function installModelBoundary(profileDir: string): string {
  const modelsDir = path.join(profileDir, 'models')
  const binDir = path.join(profileDir, 'bin')
  const llamaDir = path.join(binDir, 'llama')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.mkdirSync(llamaDir, { recursive: true })
  const model = Buffer.alloc(2_048)
  model.write('GGUF')
  fs.writeFileSync(path.join(modelsDir, 'unified-retrieval.gguf'), model)
  fs.writeFileSync(
    path.join(modelsDir, 'active-model.json'),
    JSON.stringify({ id: 'unified-retrieval-model', primary: 'unified-retrieval.gguf', mmproj: null })
  )
  const executable = path.join(llamaDir, 'llama-server')
  fs.copyFileSync(
    path.join(process.cwd(), 'e2e', 'fixtures', 'unified-retrieval-llama-server.mjs'),
    executable
  )
  fs.chmodSync(executable, 0o755)
  return binDir
}

/** The local calendar day, as the app writes it on a source ("2026-10-15"). */
function localDay(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

async function openChat(): Promise<void> {
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible()
  const captureDismiss = page.getByRole('button', { name: 'Dismiss', exact: true })
  if (await captureDismiss.isVisible().catch(() => false)) await captureDismiss.click()
}

/** The scripted model's acknowledgement of exactly this message. */
const noted = (text: string): string => `Noted (${[...text].length}).`

async function say(text: string, reply: string | RegExp = noted(text)): Promise<void> {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  await composer.fill(text)
  await composer.press('Enter')
  await expect(page.getByText(text, { exact: true }).last()).toBeVisible()
  await expect(page.getByText(reply).last()).toBeVisible({ timeout: 60_000 })
}

async function newChat(): Promise<void> {
  await page.getByRole('button', { name: 'New chat', exact: true }).first().click()
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('')
}

test.describe('unified retrieval', () => {
  test.skip(targetIsPackaged(), 'This native-boundary fixture is for the source-built E2E target.')
  test.describe.configure({ mode: 'serial', timeout: 180_000 })

  test.beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-unified-retrieval-'))
    const profileDir = path.join(rootDir, 'profile')
    const binDir = installModelBoundary(profileDir)
    modelLog = path.join(binDir, 'llama', 'requests.jsonl')
    app = await launchOffGrid({
      env: {
        ...process.env,
        OFFGRID_USER_DATA: profileDir,
        OFFGRID_BIN_DIR: binDir,
        OFFGRID_EMBEDDINGS_OFFLINE: '1',
        // Memory search across chats is a Pro tool.
        OFFGRID_PRO: '1',
        NODE_ENV: 'production',
        NO_PROXY: '127.0.0.1,localhost'
      }
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await completeOnboarding(page)
    await openChat()
  })

  // Playwright requires the first callback argument to use object destructuring.
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    // On failure, show what reached the model: the question, the tools offered, the tool results.
    if (testInfo.status !== testInfo.expectedStatus && fs.existsSync(modelLog)) {
      await testInfo.attach('model-requests', { path: modelLog, contentType: 'application/json' })
      console.log(fs.readFileSync(modelLog, 'utf8'))
    }
    const running = app
    app = null
    if (running) await running.close()
    if (path.basename(rootDir).startsWith('offgrid-unified-retrieval-')) {
      fs.rmSync(rootDir, { recursive: true, force: true })
    }
  })

  test('a fact from another chat comes back cited, dated, and opens its source', async () => {
    await say(PROMISE)

    await newChat()
    await say(
      'Search my memory: what did I promise Kunal?',
      /You promised Kunal the RBI filing by Friday/
    )

    // The answer repeats only what search_memory returned, with the day it was said.
    const answer = page.getByText(/You promised Kunal the RBI filing by Friday/).last()
    await expect(answer).toContainText(`Noted ${localDay()}.`)

    // The [S#] tag renders as a citation button; it opens the chat the fact came from.
    const citation = answer.getByRole('button', { name: /^S\d+$/ })
    await expect(citation).toBeVisible()
    await citation.click()
    await expect(page.getByText(PROMISE, { exact: true }).last()).toBeVisible()
  })

  test("the chat states today's date from the prompt's date line", async () => {
    // Built from parts: Node and the app's Chromium differ on the comma after the weekday.
    const now = new Date()
    const part = (options: Intl.DateTimeFormatOptions): string =>
      now.toLocaleDateString('en-GB', options)
    const today = new RegExp(
      `^Today is ${part({ weekday: 'long' })},? ${now.getDate()} ${part({ month: 'long' })} ${now.getFullYear()}\\.$`
    )
    await say("What is today's date?", today)
  })

  test('the search palette finds chat text by prefix, Hindi, Japanese and "today"', async () => {
    await say(ENGLISH)
    await say(HINDI)
    await say(JAPANESE)

    await page.keyboard.press('Meta+K')
    const dialog = page.getByRole('dialog', { name: 'Search Off Grid AI' })
    await expect(dialog).toBeVisible()
    const search = dialog.getByPlaceholder(/^Search everything/)

    // A word still being typed matches as a prefix.
    await search.fill('quarterl')
    await expect(dialog.getByText(/Quarterly compliance review/).first()).toBeVisible()

    // Hindi: whole words, vowel signs kept (the default tokenizer splits them apart).
    await search.fill('बजट')
    await expect(dialog.getByText(/बजट पर चर्चा/).first()).toBeVisible()

    // Japanese has no spaces between words: the trigram index finds text inside a run.
    await search.fill('東京で行')
    await expect(dialog.getByText(/会議は東京で行います/).first()).toBeVisible()

    // A time word alone lists what happened in that window.
    await search.fill('today')
    await expect(
      dialog.getByText(/Quarterly compliance review|बजट पर चर्चा|会議は東京で行います/).first()
    ).toBeVisible()
  })
})
