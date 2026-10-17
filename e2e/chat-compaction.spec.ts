/**
 * A chat that fills the model's window is summarised, and the summary rides later turns.
 *
 * Real app; the only boundary is a fake llama-server that records every request and answers a
 * compaction request with a summary carrying a marker. The model runs with a small window (4,096
 * tokens), and the chat already holds more than that. Sending a question must not end in
 * "Context is full.": the app summarises the earlier turns and sends the summary instead. The
 * next question, and one after a relaunch, carry the saved summary instead of the old turns.
 * A Japanese chat, whose characters cost more tokens each, is compacted the same way.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import { closeAndWait, mainWindow } from './helpers/windows'

const SUMMARY_MARKER = 'COMPACTED-SUMMARY-MARKER'
const COMPACTION_PROMPT = 'You are compacting a conversation'

let app: ElectronApplication | null = null
let page: Page
let profileDir: string
let modelLog: string

interface ChatRequest {
  system: string
  text: string
}

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((part: { type?: string }) => part?.type === 'text')
          .map((part: { text?: string }) => part.text ?? '')
          .join('\n')
      : ''

/** The chat requests that answered `question`: not the summary call, not a follow-up suggestion. */
const answersTo = (question: string): ChatRequest[] =>
  (fs.existsSync(modelLog) ? fs.readFileSync(modelLog, 'utf8').split('\n') : [])
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { messages?: { role: string; content: unknown }[] })
    .map((body) => {
      const messages = body.messages ?? []
      const users = messages.filter((message) => message.role === 'user')
      return {
        system: textOf(messages[0]?.content),
        last: textOf(users[users.length - 1]?.content),
        text: messages.map((message) => textOf(message.content)).join('\n')
      }
    })
    .filter(
      (request) =>
        !request.system.includes(COMPACTION_PROMPT) &&
        request.last.includes(question) &&
        !request.last.includes('The user asked:')
    )
    .map(({ system, text }) => ({ system, text }))

const compactionRequests = (): number =>
  (fs.existsSync(modelLog) ? fs.readFileSync(modelLog, 'utf8') : '')
    .split('\n')
    .filter((line) => line.includes(COMPACTION_PROMPT)).length

const launch = async (): Promise<void> => {
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profileDir,
      OFFGRID_BIN_DIR: path.join(profileDir, 'bin'),
      OFFGRID_COMPACTION_LOG: modelLog,
      OFFGRID_PRO: '0',
      NODE_ENV: 'production',
      NO_PROXY: '127.0.0.1,localhost'
    }
  })
  page = await mainWindow(app)
  await completeOnboarding(page)
}

/** A saved chat of `turns` turns, each long enough that together they overflow the window. */
const seedChat = async (
  id: string,
  title: string,
  turn: (index: number) => string,
  turns = 18
): Promise<void> =>
  page.evaluate(
    async ({ id, title, contents }) => {
      await window.api.createRagConversation(id, title, null)
      for (const [index, content] of contents.entries())
        await window.api.addRagMessage(id, index % 2 === 0 ? 'user' : 'assistant', content)
    },
    { id, title, contents: Array.from({ length: turns }, (_, index) => turn(index)) }
  )

const openChat = async (title: string): Promise<void> => {
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  await page.getByText(title, { exact: true }).first().click()
}

/** Send a question and wait until its answer has finished. */
const ask = async (question: string): Promise<void> => {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  await composer.fill(question)
  await composer.press('Enter')
  await expect.poll(() => answersTo(question).length, { timeout: 45_000 }).toBeGreaterThan(0)
  await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toBeHidden({
    timeout: 45_000
  })
  await expect(page.getByText('Context is full.', { exact: false })).toHaveCount(0)
}

test.describe('Long-chat compaction', () => {
  test.skip(targetIsPackaged(), 'This native-model boundary is for the source-built E2E target.')

  test.beforeEach(async () => {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-compaction-'))
    modelLog = path.join(profileDir, 'model-requests.jsonl')
    const modelsDir = path.join(profileDir, 'models')
    const llamaDir = path.join(profileDir, 'bin', 'llama')
    fs.mkdirSync(modelsDir, { recursive: true })
    fs.mkdirSync(llamaDir, { recursive: true })
    const gguf = Buffer.alloc(2_048)
    gguf.write('GGUF')
    fs.writeFileSync(path.join(modelsDir, 'compaction.gguf'), gguf)
    fs.writeFileSync(
      path.join(modelsDir, 'active-model.json'),
      JSON.stringify({ id: 'compaction-model', primary: 'compaction.gguf', mmproj: null })
    )
    // A small window, as a person sets it in the model's settings.
    fs.writeFileSync(path.join(modelsDir, 'llm-settings.json'), JSON.stringify({ ctxSize: 4096 }))
    const executable = path.join(llamaDir, 'llama-server')
    fs.copyFileSync(path.resolve('e2e/fixtures/chat-compaction-llama-server.mjs'), executable)
    fs.chmodSync(executable, 0o755)
    await launch()
  })

  // Playwright requires the first callback argument to use object destructuring.
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    if (app) await closeAndWait(app)
    app = null
    if (fs.existsSync(modelLog))
      fs.copyFileSync(modelLog, testInfo.outputPath('model-requests.jsonl'))
    fs.rmSync(profileDir, { recursive: true, force: true })
  })

  test('A full chat is summarised, and the summary rides later turns and a relaunch', async () => {
    test.setTimeout(180_000)
    await seedChat(
      'compaction-english',
      'Harbour festival planning',
      (index) =>
        `OLDTURN-${index} ` +
        'We talked about the harbour lantern festival: the stalls, the music on the pier, the boats lit after dark, the volunteers who carry the lanterns and the route along the old stone wall. '.repeat(
          5
        )
    )
    await openChat('Harbour festival planning')

    const first = 'What should we do first for the festival?'
    await ask(first)
    expect(compactionRequests()).toBeGreaterThanOrEqual(1)
    const firstAnswer = answersTo(first).at(-1)!
    expect(firstAnswer.text).toContain(SUMMARY_MARKER)
    expect(firstAnswer.text).not.toContain('OLDTURN-1 ')

    // The saved summary stands in for the old turns on the next question.
    const second = 'And what comes after that?'
    await ask(second)
    const secondAnswer = answersTo(second).at(-1)!
    expect(secondAnswer.text).toContain(SUMMARY_MARKER)
    expect(secondAnswer.text).not.toContain('OLDTURN-1 ')

    // And after a relaunch.
    await closeAndWait(app!)
    await launch()
    await openChat('Harbour festival planning')
    const third = 'Remind me what we planned.'
    await ask(third)
    const thirdAnswer = answersTo(third).at(-1)!
    expect(thirdAnswer.text).toContain(SUMMARY_MARKER)
    expect(thirdAnswer.text).not.toContain('OLDTURN-1 ')
  })

  test('A Japanese chat is compacted in time', async () => {
    test.setTimeout(120_000)
    await seedChat(
      'compaction-japanese',
      '港の祭りの計画',
      (index) =>
        `OLDTURN-${index} ` +
        '港のランタン祭りについて話しました。屋台、桟橋の音楽、夜に灯る船、ランタンを運ぶボランティア、古い石垣に沿った道。'.repeat(
          5
        )
    )
    await openChat('港の祭りの計画')
    const question = '祭りの準備は何から始めますか?'
    await ask(question)
    expect(compactionRequests()).toBeGreaterThanOrEqual(1)
    const answer = answersTo(question).at(-1)!
    expect(answer.text).toContain(SUMMARY_MARKER)
    expect(answer.text).not.toContain('OLDTURN-1 ')
  })
})
