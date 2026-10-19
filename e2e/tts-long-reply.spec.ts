/**
 * Speak reads a long reply to the end, and starts before the whole reply is made.
 *
 * The speech engine reads only so much text at once, so a long reply is spoken in passes and the
 * passes are joined into one clip. Only the external Kokoro model is fake: it records each pass's
 * text, takes a moment per pass and returns a clip of known length. The ONNX worker, the WAV join,
 * IPC and the renderer's player are production code.
 *
 * Asserts: several passes run and together hold every word in order, the first one opens the
 * reply, playback starts before the last pass is ready, and the joined clip is as long as the
 * passes together.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import { closeAndWait, mainWindow } from './helpers/windows'

const CONVERSATION = 'tts-long-reply'
const PASS_SECONDS = 2
const PASS_DELAY_MS = 900
/** About 1,500 characters: twelve sentences, each with its own marker word. */
const SENTENCES = Array.from(
  { length: 12 },
  (_, index) =>
    `Sentence marker${index + 1} walks the long reply forward through the quiet harbour, past the lanterns, the boats, the gulls and the old stone wall, so that every pass must carry its share of the words.`
)
const REPLY = SENTENCES.join(' ')

interface PassEntry {
  text: string
  seconds: number
  readyAt: number
}

let app: ElectronApplication | null = null
let page: Page
let root: string
let passLog: string

const passes = (): PassEntry[] =>
  fs.existsSync(passLog)
    ? fs
        .readFileSync(passLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as PassEntry)
    : []

/** Words only, so pass boundaries and spacing do not matter. */
const words = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? []

test.describe('Speak a long reply', () => {
  test.skip(targetIsPackaged(), 'This native-model boundary is for the source-built E2E target.')

  test.beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-tts-long-'))
    const profile = path.join(root, 'profile')
    fs.mkdirSync(path.join(profile, 'models'), { recursive: true })
    passLog = path.join(root, 'passes.jsonl')
    app = await launchOffGrid({
      appEntry: 'e2e/fixtures/tts-kokoro-boundary.cjs',
      env: {
        ...process.env,
        OFFGRID_USER_DATA: profile,
        OFFGRID_TTS_CAPTURE: path.join(root, 'spoken.txt'),
        OFFGRID_TTS_PASS_LOG: passLog,
        OFFGRID_TTS_PASS_SECONDS: String(PASS_SECONDS),
        OFFGRID_TTS_PASS_DELAY_MS: String(PASS_DELAY_MS),
        OFFGRID_PRO: '1',
        NODE_ENV: 'production'
      }
    })
    page = await mainWindow(app)
    // When each clip starts playing, and how long it is: the audio element is the browser's
    // boundary, so it is watched, not replaced.
    await page.evaluate(() => {
      const plays: { at: number; element: HTMLMediaElement }[] = []
      ;(window as unknown as { __plays: typeof plays }).__plays = plays
      const play = HTMLMediaElement.prototype.play
      HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
        plays.push({ at: Date.now(), element: this })
        return play.call(this)
      }
    })
    await completeOnboarding(page)
    await page.evaluate(
      async ({ id, reply }) => {
        await window.api.createRagConversation(id, 'Long reply to speak', null)
        await window.api.addRagMessage(id, 'assistant', reply)
      },
      { id: CONVERSATION, reply: REPLY }
    )
    await page.getByRole('button', { name: 'Chat', exact: true }).click()
  })

  test.afterEach(async () => {
    if (app) await closeAndWait(app)
    app = null
    fs.rmSync(root, { recursive: true, force: true })
  })

  test('Speak reads every word of a long reply and starts before the last pass', async () => {
    test.setTimeout(120_000)
    await page.getByText('Long reply to speak').first().click()
    await expect(page.getByText(SENTENCES[0]!).first()).toBeVisible()

    await page.getByRole('button', { name: 'Message actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Speak', exact: true }).click()

    // The first sound plays while the rest of the reply is still being made.
    await expect
      .poll(
        () => page.evaluate(() => (window as unknown as { __plays: unknown[] }).__plays.length),
        {
          timeout: 45_000
        }
      )
      .toBeGreaterThan(0)
    const firstPlayAt = await page.evaluate(
      () => (window as unknown as { __plays: { at: number }[] }).__plays[0]!.at
    )
    await page.getByRole('button', { name: 'Message actions', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: 'Stop', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')

    // Every pass is made, in order, and together they hold every word of the reply.
    await expect
      .poll(
        () =>
          words(
            passes()
              .map((pass) => pass.text)
              .join(' ')
          ).length,
        { timeout: 60_000 }
      )
      .toBe(words(REPLY).length)
    const made = passes()
    expect(made.length).toBeGreaterThanOrEqual(3)
    // The first pass is short (at most the first sentence) and opens the reply, so the voice starts soon.
    const opening = words(made[0]!.text)
    expect(opening.length).toBeLessThanOrEqual(words(SENTENCES[0]!).length)
    expect(words(REPLY).slice(0, opening.length)).toEqual(opening)
    expect(words(made.map((pass) => pass.text).join(' '))).toEqual(words(REPLY))
    expect(firstPlayAt).toBeLessThan(made[made.length - 1]!.readyAt)

    // Playback moves onto the joined clip, which is as long as all the passes together.
    const expected = made.length * PASS_SECONDS
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Math.max(
              0,
              ...(window as unknown as { __plays: { element: HTMLMediaElement }[] }).__plays
                .map((entry) => entry.element.duration)
                .filter(Number.isFinite)
            )
          ),
        { timeout: 60_000 }
      )
      .toBeGreaterThan(expected - 0.5)
    const longest = await page.evaluate(() =>
      Math.max(
        ...(window as unknown as { __plays: { element: HTMLMediaElement }[] }).__plays
          .map((entry) => entry.element.duration)
          .filter(Number.isFinite)
      )
    )
    expect(longest).toBeLessThan(expected + 0.5)
  })
})
