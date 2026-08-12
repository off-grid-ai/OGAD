/**
 * RELEASE_TEST_CHECKLIST #44 and #46 - conversation rename and assistant-copy
 * cross the real Electron renderer, preload, IPC, SQLite, and OS clipboard seams.
 * Synthetic records are created through production IPC in a fresh temp profile.
 */
import { test, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { launchOffGrid } from './helpers/launch'
import type { ChildProcess } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const RENAME_ID = 'e2e-rename-target'
const RENAME_BEFORE = 'Before exact rename'
const RENAME_AFTER = 'After exact rename'
const RENAME_MESSAGE = 'This persisted message identifies the renamed conversation.'
const NAVIGATION_ID = 'e2e-rename-navigation'
const NAVIGATION_TITLE = 'Navigation checkpoint'
const NAVIGATION_MESSAGE = 'This is the other conversation used for navigation.'
const COPY_ID = 'e2e-copy-target'
const COPY_TITLE = 'Clipboard checkpoint'
const COPY_USER_MESSAGE = 'Copy the exact assistant response.'
const COPY_ASSISTANT_MESSAGE = 'Synthetic assistant reply copied through production IPC.'

let app: ElectronApplication | null = null
let page: Page
let userDataDir: string

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
}

async function launchApp(): Promise<void> {
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_PRO: '0',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
}

async function closeApp(): Promise<void> {
  const running = app
  if (!running) return
  app = null
  const child = running.process()
  await running.close()
  await waitForExit(child)
}

async function finishOnboarding(): Promise<void> {
  for (let step = 0; step < 8; step += 1) {
    const button = page.getByRole('button', { name: /Continue|Start using Off Grid/i })
    if (!(await button.isVisible().catch(() => false))) return
    await button.click()
  }
}

async function enterChat(): Promise<void> {
  await finishOnboarding()
  // By role and name, not by title: the sidebar opens EXPANDED, and App.tsx sets
  // title={!sidebarOpen ? item.label : undefined} - the title attribute belongs to the collapsed rail
  // only. An expanded nav carries its label as visible text, so getByTitle waits 30s for an attribute
  // the app is right not to render.
  await page.getByRole('button', { name: 'Chat', exact: true }).click()

  const setupBanner = page
    .locator('div')
    .filter({ hasText: /set up your local ai/i })
    .first()
  if (await setupBanner.isVisible().catch(() => false)) {
    await setupBanner.locator('button').last().click()
  }
  await page.keyboard.press('Escape')
  await expect(page.getByPlaceholder(/ask anything/i)).toBeVisible()
}

async function seedRenameJourney(): Promise<void> {
  await page.evaluate(
    async ({
      renameId,
      renameTitle,
      renameMessage,
      navigationId,
      navigationTitle,
      navigationMessage
    }) => {
      await window.api.createRagConversation(renameId, renameTitle, null)
      await window.api.addRagMessage(renameId, 'user', renameMessage)
      await window.api.createRagConversation(navigationId, navigationTitle, null)
      await window.api.addRagMessage(navigationId, 'assistant', navigationMessage)
    },
    {
      renameId: RENAME_ID,
      renameTitle: RENAME_BEFORE,
      renameMessage: RENAME_MESSAGE,
      navigationId: NAVIGATION_ID,
      navigationTitle: NAVIGATION_TITLE,
      navigationMessage: NAVIGATION_MESSAGE
    }
  )
}

async function seedCopyJourney(): Promise<void> {
  await page.evaluate(
    async ({ id, title, userMessage, assistantMessage }) => {
      await window.api.createRagConversation(id, title, null)
      await window.api.addRagMessage(id, 'user', userMessage)
      await window.api.addRagMessage(id, 'assistant', assistantMessage)
    },
    {
      id: COPY_ID,
      title: COPY_TITLE,
      userMessage: COPY_USER_MESSAGE,
      assistantMessage: COPY_ASSISTANT_MESSAGE
    }
  )
}

function conversationRow(title: string): Locator {
  return page
    .getByRole('button', { name: `Conversation actions for ${title}` })
    .locator('xpath=ancestor::div[contains(@class, "cursor-pointer")][1]')
}

test.beforeEach(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-chat-actions-'))
  await launchApp()
  await finishOnboarding()
})

test.afterEach(async () => {
  if (app) {
    await app.evaluate(({ clipboard }) => clipboard.clear()).catch(() => undefined)
  }
  await closeApp()
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

test('renames through the UI, navigates back, and restores the title after relaunch (#44)', async () => {
  await seedRenameJourney()
  await enterChat()

  const targetRow = conversationRow(RENAME_BEFORE)
  await targetRow.hover()
  await targetRow.getByRole('button', { name: `Conversation actions for ${RENAME_BEFORE}` }).click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  const renameInput = page.getByRole('textbox', { name: 'Rename conversation' })
  await expect(renameInput).toBeFocused()
  await renameInput.fill(`  ${RENAME_AFTER}  `)
  await page.getByRole('button', { name: 'Save conversation name' }).click()

  await expect(
    page.getByRole('button', { name: `Conversation actions for ${RENAME_AFTER}` })
  ).toBeVisible()
  await expect(page.getByText(RENAME_BEFORE, { exact: true })).toHaveCount(0)

  await conversationRow(NAVIGATION_TITLE).click()
  // .last() for the same reason the copy journey below documents: the chat list previews each
  // conversation's last message, so this text is on screen twice and the rail comes first in the DOM.
  // The transcript copy is the one that proves the conversation actually switched.
  await expect(page.getByText(NAVIGATION_MESSAGE, { exact: true }).last()).toBeVisible()
  await conversationRow(RENAME_AFTER).click()
  await expect(page.getByText(RENAME_MESSAGE, { exact: true }).last()).toBeVisible()

  const storedBeforeRelaunch = await page.evaluate(async (id) => {
    const conversation = await window.api.getRagConversation(id)
    return conversation?.title ?? null
  }, RENAME_ID)
  expect(storedBeforeRelaunch).toBe(RENAME_AFTER)
  await page.screenshot({ path: 'e2e/screenshots/conversation-renamed.png' })

  await closeApp()
  await launchApp()
  await enterChat()

  await expect(
    page.getByRole('button', { name: `Conversation actions for ${RENAME_AFTER}` })
  ).toBeVisible()
  await conversationRow(RENAME_AFTER).click()
  await expect(page.getByText(RENAME_MESSAGE, { exact: true }).last()).toBeVisible()
  // Absence stays unscoped on purpose: the old title must be gone from the rail AND the transcript.
  await expect(page.getByText(RENAME_BEFORE, { exact: true })).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(
        async (id) => (await window.api.getRagConversation(id))?.title ?? null,
        RENAME_ID
      )
    )
    .toBe(RENAME_AFTER)
})

test('copies an assistant reply through production IPC to the real OS clipboard (#46)', async () => {
  await seedCopyJourney()
  await enterChat()
  // .last() throughout: the chat list shows each conversation's last message as a preview, so this reply
  // is on screen twice - truncated in the history rail and in full in its bubble - and an unscoped
  // locator is strict-mode ambiguous for a UI that is behaving correctly. The rail comes first in the
  // DOM, so the last match is the bubble, which is the one with a Copy button on it.
  const replyInTranscript = page.getByText(COPY_ASSISTANT_MESSAGE, { exact: true }).last()
  await expect(replyInTranscript).toBeVisible()

  await app!.evaluate(({ clipboard }) => clipboard.writeText('synthetic clipboard sentinel'))
  const assistantTurn = replyInTranscript
    .locator(
      'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " mb-5 ")][1]'
    )
  await assistantTurn.getByTitle('Copy').click()

  await expect(assistantTurn.getByText('Copied', { exact: true })).toBeVisible()
  await expect
    .poll(() => app!.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe(COPY_ASSISTANT_MESSAGE)
  await page.screenshot({ path: 'e2e/screenshots/assistant-reply-copied.png' })
})
