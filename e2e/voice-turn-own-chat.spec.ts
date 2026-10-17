/**
 * A voice note lands in the chat it was recorded in.
 *
 * Real app, real voice-mode recording (Chromium's fake microphone), real chat and persistence; the
 * boundaries are ffmpeg, a whisper-cli that takes a few seconds, and a fake llama-server that
 * records every request. The person records in chat A, then opens chat B before the note is
 * transcribed.
 *
 * Asserts: the transcript and its reply are saved in A, which shows them when opened again; B
 * gets nothing, and no model request carries B's history with the note.
 */
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import { closeAndWait, mainWindow } from './helpers/windows'

const SAID = 'Book a table by the river for Friday'
const CHAT_A = { id: 'voice-chat-a', title: 'Dinner plans', first: 'Where should we eat?' }
const CHAT_B = { id: 'voice-chat-b', title: 'Garden chores', first: 'When do I prune roses?' }

let app: ElectronApplication | null = null
let page: Page
let profileDir: string
let modelLog: string
let whisperLog: string

const messages = (conversation: string): Promise<{ role: string; content: string }[]> =>
  page.evaluate(
    async (id) =>
      (await window.api.getRagMessages(id)).map((message: { role: string; content: string }) => ({
        role: message.role,
        content: message.content
      })),
    conversation
  )

const openChat = async (title: string): Promise<void> => {
  await page.getByText(title, { exact: true }).first().click()
}

test.describe('Voice turn and its chat', () => {
  test.skip(targetIsPackaged(), 'These native boundaries are for the source-built E2E target.')

  test.beforeEach(async () => {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-voice-own-chat-'))
    modelLog = path.join(profileDir, 'model-requests.jsonl')
    whisperLog = path.join(profileDir, 'whisper-runs.log')
    const modelsDir = path.join(profileDir, 'models')
    const binDir = path.join(profileDir, 'bin')
    fs.mkdirSync(modelsDir, { recursive: true })
    fs.mkdirSync(path.join(binDir, 'llama'), { recursive: true })
    fs.mkdirSync(path.join(binDir, 'whisper'), { recursive: true })
    const gguf = Buffer.alloc(2_048)
    gguf.write('GGUF')
    fs.writeFileSync(path.join(modelsDir, 'voice-chat.gguf'), gguf)
    fs.writeFileSync(
      path.join(modelsDir, 'active-model.json'),
      JSON.stringify({ id: 'voice-chat-model', primary: 'voice-chat.gguf', mmproj: null })
    )
    fs.writeFileSync(path.join(modelsDir, 'ggml-base.bin'), 'synthetic whisper model')
    const install = (from: string, to: string): void => {
      fs.copyFileSync(path.resolve(from), path.join(binDir, to))
      fs.chmodSync(path.join(binDir, to), 0o755)
    }
    install('e2e/fixtures/chat-compaction-llama-server.mjs', 'llama/llama-server')
    install('e2e/fixtures/slow-whisper-cli.sh', 'whisper/whisper-cli')
    install('e2e/fixtures/copy-ffmpeg.sh', 'ffmpeg')
    fs.copyFileSync(
      path.resolve('e2e/fixtures/hey-how-are-you-doing.wav'),
      path.join(profileDir, 'e2e-voice.wav')
    )
    app = await launchOffGrid({
      extraArgs: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-audio-capture=${path.resolve('e2e/fixtures/hey-how-are-you-doing.wav')}`
      ],
      env: {
        ...process.env,
        OFFGRID_USER_DATA: profileDir,
        OFFGRID_BIN_DIR: binDir,
        OFFGRID_COMPACTION_LOG: modelLog,
        OFFGRID_WHISPER_LOG: whisperLog,
        OFFGRID_PRO: '0',
        NODE_ENV: 'production',
        NO_PROXY: '127.0.0.1,localhost'
      }
    })
    page = await mainWindow(app)
    await completeOnboarding(page)
    await page.evaluate(
      async (chats) => {
        for (const chat of chats) {
          await window.api.createRagConversation(chat.id, chat.title, null)
          await window.api.addRagMessage(chat.id, 'user', chat.first)
          await window.api.addRagMessage(chat.id, 'assistant', `Answered: ${chat.first}`)
        }
      },
      [CHAT_A, CHAT_B]
    )
  })

  // Playwright requires the first callback argument to use object destructuring.
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    if (app) await closeAndWait(app)
    app = null
    if (modelLog && fs.existsSync(modelLog))
      fs.copyFileSync(modelLog, testInfo.outputPath('model-requests.jsonl'))
    const appLog = path.join(profileDir, 'logs', 'off-grid-ai-desktop.log')
    if (fs.existsSync(appLog)) fs.copyFileSync(appLog, testInfo.outputPath('app.log'))
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true })
  })

  test('A note recorded in chat A is answered in A after switching to chat B', async () => {
    test.setTimeout(120_000)
    await page.getByRole('button', { name: 'Chat', exact: true }).click()
    await openChat(CHAT_A.title)
    await expect(page.getByText(CHAT_A.first).first()).toBeVisible()
    await page
      .getByTestId('chat-composer')
      .getByRole('button', { name: 'Voice', exact: true })
      .click()
    await expect(
      page.getByRole('group', { name: 'Voice mode' }).getByRole('button', { pressed: true })
    ).toBeVisible()

    await page
      .getByRole('group', { name: 'Voice turn mode' })
      .getByRole('button', { name: 'Manual', exact: true })
      .click()
    await page.getByRole('button', { name: 'Start voice recording', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Stop voice recording', exact: true })
    ).toBeVisible()
    await page.waitForTimeout(1_500)
    await page.getByRole('button', { name: 'Stop voice recording', exact: true }).click()
    // Transcription has started; the person moves to chat B before it finishes.
    await expect.poll(() => fs.existsSync(whisperLog), { timeout: 15_000 }).toBe(true)
    await openChat(CHAT_B.title)
    await expect(page.getByText(CHAT_B.first).first()).toBeVisible()

    // The note and its answer are saved in A.
    await expect
      .poll(async () => (await messages(CHAT_A.id)).map((message) => message.content), {
        timeout: 45_000
      })
      .toEqual(expect.arrayContaining([SAID, `Answered: ${SAID}`]))
    expect(await messages(CHAT_B.id)).toEqual([
      { role: 'user', content: CHAT_B.first },
      { role: 'assistant', content: `Answered: ${CHAT_B.first}` }
    ])
    // In the chat list, A's latest message is the note's answer and B's is unchanged.
    const row = (title: string): Locator =>
      page.getByRole('button', { name: new RegExp(`^${title} Conversation actions`) })
    await expect(row(CHAT_A.title)).toContainText(`Answered: ${SAID}`)
    await expect(row(CHAT_B.title)).toContainText(`Answered: ${CHAT_B.first}`)
    await expect(row(CHAT_B.title)).not.toContainText(SAID)
    await expect(page.getByText('recorded in another chat', { exact: false })).toHaveCount(0)

    // The model answered the note with A's history, never B's.
    const turns = fs
      .readFileSync(modelLog, 'utf8')
      .split('\n')
      .filter((line) => line.includes(SAID) && !line.includes('The user asked:'))
    expect(turns.length).toBeGreaterThan(0)
    for (const turn of turns) {
      expect(turn).toContain(CHAT_A.first)
      expect(turn).not.toContain(CHAT_B.first)
    }

    // Opening A again shows the note and its answer.
    await openChat(CHAT_A.title)
    await expect(page.getByText(`Answered: ${SAID}`).first()).toBeVisible()
  })
})
