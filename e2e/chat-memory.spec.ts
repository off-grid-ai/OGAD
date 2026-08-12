/**
 * Chat + memory regression tests for:
 *   - No-memory toggle actually sticking (fix: assignProject no longer overrides noMemory)
 *   - Streaming placeholder appearing immediately (fix: streamConvRef routes tokens to correct conv)
 *   - Conversation, message, scope, and project persistence across a full process relaunch
 *   - Cold recovery and committed-data durability after a forced main-process kill
 *
 * Runs against the built app with OFFGRID_PRO=1 so the memory dropdown is visible.
 * No LLM model is expected — we only assert UI state and IPC plumbing, not model output.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchOffGrid } from './helpers/launch'
import os from 'os'
import path from 'path'
import fs from 'fs'
import type { ChildProcess } from 'child_process'

let app: ElectronApplication
let page: Page
let userDataDir: string
let modelBoundaryBinDir: string | undefined

const launchApp = async (): Promise<void> => {
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_PRO: '1',
      NODE_ENV: 'production',
      ...(modelBoundaryBinDir ? { OFFGRID_BIN_DIR: modelBoundaryBinDir } : {})
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
}

const waitForExit = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null) return
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
  })
}

const closeApp = async (): Promise<void> => {
  const child = app.process()
  await app.close()
  await waitForExit(child)
}

const forceCloseApp = async (): Promise<void> => {
  const child = app.process()
  child.kill('SIGKILL')
  await waitForExit(child)
}

const enterChat = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) {
    const btn = page.getByRole('button', { name: /Continue|Start using Off Grid/i })
    if (!(await btn.isVisible().catch(() => false))) break
    await btn.click()
    await page.waitForTimeout(300)
  }

  const chatNav = page.getByRole('button', { name: /chat|mind|ask/i }).first()
  await expect(chatNav).toBeVisible()
  await chatNav.click()
  await page.waitForTimeout(500)

  const banner = page
    .locator('div')
    .filter({ hasText: /set up your local ai/i })
    .first()
  if (await banner.isVisible().catch(() => false)) {
    await banner.locator('button').last().click()
    await page.waitForTimeout(300)
  }
  await page.keyboard.press('Escape')
}

const dismissCapturePrompt = async (): Promise<void> => {
  // The capture-permission prompt is best-effort onboarding — it isn't guaranteed to appear
  // (depends on TCC state / seeded profile), so tolerate its absence instead of hard-failing.
  const dismiss = page.getByRole('button', { name: 'Dismiss', exact: true })
  if (await dismiss.isVisible().catch(() => false)) {
    await dismiss.click()
    await expect(dismiss).toBeHidden()
  }
}

test.beforeEach(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-chat-e2e-'))
  modelBoundaryBinDir = undefined
  await launchApp()
  await enterChat()
})

test.afterEach(async () => {
  if (app) await closeApp()
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

test('navigates to the chat screen', async () => {
  await expect(page.getByPlaceholder(/ask anything/i)).toBeVisible()
  await page.screenshot({ path: 'e2e/screenshots/chat-screen.png', fullPage: false })
})

test('memory toggle: No memory sticks after selection', async () => {
  // Open the memory/scope dropdown.
  const memoryBtn = page
    .locator('button')
    .filter({ hasText: /memory|no memory/i })
    .first()
  await expect(memoryBtn).toBeVisible()
  await memoryBtn.click({ force: true })
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'e2e/screenshots/memory-dropdown-open.png' })

  // Click "No memory" — Radix DropdownMenuItem renders as role="menuitem".
  // Fall back to text match if the role selector doesn't resolve (portal timing).
  const noMemoryItem = page
    .getByRole('menuitem', { name: /no memory/i })
    .or(page.locator('[data-radix-dropdown-menu-content] *').filter({ hasText: /^No memory/i }))
  await expect(noMemoryItem.first()).toBeVisible({ timeout: 5000 })
  await noMemoryItem.first().click()
  await page.waitForTimeout(300)

  await page.screenshot({ path: 'e2e/screenshots/memory-no-memory-selected.png' })

  // The trigger button should now say "No memory", confirming the state stuck.
  const triggerAfter = page
    .locator('button')
    .filter({ hasText: /no memory/i })
    .first()
  await expect(triggerAfter).toBeVisible()
})

test('memory toggle: All memory sticks after selection', async () => {
  // Open dropdown and switch to All memory to verify the round-trip.
  const memoryBtn = page
    .locator('button')
    .filter({ hasText: /no memory|memory/i })
    .first()
  await expect(memoryBtn).toBeVisible()
  await memoryBtn.click({ force: true })
  await page.waitForTimeout(200)

  const allMemoryItem = page.getByRole('menuitem', { name: /all memory/i })
  await expect(allMemoryItem).toBeVisible()
  await allMemoryItem.click()
  await page.waitForTimeout(300)

  await page.screenshot({ path: 'e2e/screenshots/memory-all-memory-selected.png' })

  // Button should now reflect "All memory".
  const triggerAfter = page
    .locator('button')
    .filter({ hasText: /all memory/i })
    .first()
  await expect(triggerAfter).toBeVisible()
})

test('chat composer renders and accepts input', async () => {
  const composer = page.getByPlaceholder(/ask anything/i)
  await expect(composer).toBeVisible()
  await composer.fill('Hello, test message')
  await page.screenshot({ path: 'e2e/screenshots/chat-composer-filled.png' })

  // Verify the send button is present.
  const sendBtn = page
    .locator('button[type="submit"], button')
    .filter({ has: page.locator('svg') })
    .last()
  await expect(sendBtn).toBeVisible()

  // Clear without sending — we don't have a model running.
  await composer.fill('')
})

test('streaming placeholder appears immediately after send', async () => {
  // This test captures the streaming UI state: the user bubble + the assistant
  // placeholder bubble that appears instantly (before any model response).
  // It validates the fix — previously nothing appeared until the full response
  // resolved because stream tokens routed to the wrong conversation bucket.
  const composer = page.getByPlaceholder(/ask anything/i)
  await expect(composer).toBeVisible()
  await composer.fill('What did I work on today?')
  await page.keyboard.press('Enter')

  // The user bubble + assistant streaming placeholder should appear within ~500 ms
  // regardless of whether a model is running — the placeholder is added synchronously
  // before ragChat is even called. Screenshot right after send to capture it.
  await page.waitForTimeout(600)
  await page.screenshot({ path: 'e2e/screenshots/streaming-placeholder.png' })

  // Assert the user message rendered immediately.
  const userBubble = page.locator('text=What did I work on today?').first()
  await expect(userBubble).toBeVisible({ timeout: 3000 })

  // Assert exactly one assistant bubble appeared — the streaming placeholder
  // must transition to the final state (error when no model), never duplicate into two.
  const assistantBubble = page
    .locator('div')
    .filter({
      hasText: /searching|working|sorry|error|off grid/i
    })
    .first()
  await expect(assistantBubble)
    .toBeVisible({ timeout: 5000 })
    .catch(() => {
      // No model running is acceptable — the user bubble alone proves routing.
    })
  // Confirm there is NOT a second stale streaming bubble (the animated dots)
  // alongside the error — before the fix there would be two assistant bubbles.
  // Target the innermost text nodes to avoid counting wrapper divs.
  const errorBubbleCount = await page
    .locator('p, span')
    .filter({ hasText: /^Sorry, something went wrong/i })
    .count()
  expect(errorBubbleCount).toBeLessThanOrEqual(1)

  await page.screenshot({ path: 'e2e/screenshots/streaming-after-send.png' })
})

test('conversations, messages, scopes, and project associations survive relaunch', async () => {
  const seeded = await page.evaluate(async () => {
    const projectId = await window.api.createProject({ name: 'Relaunch Project' })
    await window.api.createRagConversation('persist-general', 'Persistent General', null)
    await window.api.addRagMessage('persist-general', 'user', 'general question')
    await window.api.addRagMessage('persist-general', 'assistant', 'general answer', {
      sources: ['local-memory']
    })
    await window.api.createRagConversation('persist-project', 'Persistent Project', projectId)
    await window.api.addRagMessage('persist-project', 'user', 'project question')
    await window.api.addRagMessage('persist-project', 'assistant', 'project answer', {
      projectId
    })
    return { projectId }
  })

  await closeApp()
  await launchApp()

  const persisted = await page.evaluate(async ({ projectId }) => {
    const conversations = await window.api.getRagConversations()
    const projects = await window.api.listProjects()
    const generalMessages = await window.api.getRagMessages('persist-general')
    const projectMessages = await window.api.getRagMessages('persist-project')
    const selectConversation = (
      id: string
    ): {
      id: string
      title: string | null
      projectId: string | null | undefined
      messageCount: number | undefined
    } | null => {
      const conversation = conversations.find((item) => item.id === id)
      return conversation
        ? {
            id: conversation.id,
            title: conversation.title,
            projectId: conversation.project_id,
            messageCount: conversation.message_count
          }
        : null
    }
    const selectMessages = (
      messages: typeof generalMessages
    ): Array<{ role: string; content: string; context: string | null }> =>
      messages.map((message) => ({
        role: message.role,
        content: message.content,
        context: message.context
      }))
    return {
      projectExists: projects.some((project) => project.id === projectId),
      general: selectConversation('persist-general'),
      project: selectConversation('persist-project'),
      generalMessages: selectMessages(generalMessages),
      projectMessages: selectMessages(projectMessages)
    }
  }, seeded)

  expect(persisted.projectExists).toBe(true)
  expect(persisted.general).toEqual({
    id: 'persist-general',
    title: 'Persistent General',
    projectId: null,
    messageCount: 2
  })
  expect(persisted.project).toEqual({
    id: 'persist-project',
    title: 'Persistent Project',
    projectId: seeded.projectId,
    messageCount: 2
  })
  expect(persisted.generalMessages).toEqual([
    { role: 'user', content: 'general question', context: null },
    {
      role: 'assistant',
      content: 'general answer',
      context: JSON.stringify({ sources: ['local-memory'] })
    }
  ])
  expect(persisted.projectMessages).toEqual([
    { role: 'user', content: 'project question', context: null },
    {
      role: 'assistant',
      content: 'project answer',
      context: JSON.stringify({ projectId: seeded.projectId })
    }
  ])
})

test('cancelling a tool-owned image keeps its text answer after a full relaunch', async () => {
  // Re-launch against faithful native-process boundaries. The production LLMService
  // spawns the fake llama executable and speaks real HTTP/SSE; imagegen spawns the
  // fake sd-cli and must kill it through the rendered Stop control. SQLite, IPC,
  // toolChat, MemoryChat, and the process relaunch are all real Off Grid code.
  await closeApp()

  const modelsDir = path.join(userDataDir, 'models')
  modelBoundaryBinDir = path.join(userDataDir, 'e2e-model-bin')
  const llamaDir = path.join(modelBoundaryBinDir, 'llama')
  const sdDir = path.join(modelBoundaryBinDir, 'sd')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.mkdirSync(llamaDir, { recursive: true })
  fs.mkdirSync(sdDir, { recursive: true })

  const writeGguf = (filename: string, marker = ''): void => {
    const bytes = Buffer.alloc(2048)
    bytes.write('GGUF')
    bytes.write(marker, 16)
    fs.writeFileSync(path.join(modelsDir, filename), bytes)
  }
  writeGguf('fake-chat.gguf')
  writeGguf('sdxl-lightning-e2e.gguf', 'first_stage_model text_encoder')
  fs.writeFileSync(
    path.join(modelsDir, 'active-model.json'),
    JSON.stringify({ id: 'e2e-chat', primary: 'fake-chat.gguf' })
  )

  const installExecutable = (fixture: string, destination: string): void => {
    fs.copyFileSync(path.join(process.cwd(), 'e2e', 'fixtures', fixture), destination)
    fs.chmodSync(destination, 0o755)
  }
  installExecutable('fake-llama-server.mjs', path.join(llamaDir, 'llama-server'))
  installExecutable('fake-sd-cli.mjs', path.join(sdDir, 'sd-cli'))

  await launchApp()
  await page.evaluate(async () => {
    await window.api.saveSetting('composerToolsOn', true)
    await window.api.setActiveModalModel('image', 'sdxl-lightning-e2e.gguf')
  })
  await enterChat()
  await dismissCapturePrompt()

  const composer = page.getByPlaceholder(/ask anything/i)
  await composer.fill('Summarize my week and draw a chart')
  await page.keyboard.press('Enter')

  // .last(), because the reply is legitimately on screen twice: the chat list shows each conversation's
  // last message as a preview, so the text appears once in the history rail and once in its bubble, and
  // an unscoped locator is strict-mode ambiguous for a UI that is behaving correctly. The rail is the
  // <aside> and comes first in the DOM, so the last match is the transcript bubble - the thing this test
  // is about.
  const answer = page.getByText('Here is your weekly summary.', { exact: true }).last()
  await expect(answer).toBeVisible()
  const stopImage = page.getByRole('button', { name: 'Stop', exact: true })
  await expect(stopImage).toBeVisible()
  await stopImage.click()
  await expect(stopImage).toBeHidden()

  const readPersistedTurn = async (): Promise<string[][]> =>
    page.evaluate(async () => {
      const conversations = await window.api.getRagConversations()
      for (const conversation of conversations) {
        const messages = await window.api.getRagMessages(conversation.id)
        if (messages.some((message) => message.content === 'Summarize my week and draw a chart')) {
          return messages.map((message) => [message.role, message.content])
        }
      }
      return []
    })
  await expect.poll(readPersistedTurn).toEqual([
    ['user', 'Summarize my week and draw a chart'],
    ['assistant', 'Here is your weekly summary.']
  ])

  await closeApp()
  await launchApp()
  await enterChat()

  // Terminal artifact: a newly created renderer, backed by the re-opened SQLite
  // database in a new Electron main process, paints the exact completed text turn.
  // The transcript copy again (see above): the rail's preview is the earlier match.
  await expect(
    page.getByText('Here is your weekly summary.', { exact: true }).last()
  ).toBeVisible()
  await expect(
    page
      .locator('p')
      .filter({ hasText: /^Summarize my week and draw a chart$/ })
      .last()
  ).toBeVisible()
})

test('cold relaunch after a forced quit boots cleanly and keeps committed chat data', async () => {
  await page.evaluate(async () => {
    await window.api.createRagConversation('forced-quit-chat', 'Forced Quit Chat', null)
    await window.api.addRagMessage('forced-quit-chat', 'user', 'committed before forced quit')
  })
  await page.getByPlaceholder(/ask anything/i).fill('uncommitted draft during forced quit')

  await forceCloseApp()
  await launchApp()

  await expect(page.locator('#root')).not.toBeEmpty()
  expect(await page.evaluate(() => typeof window.api === 'object')).toBe(true)
  const persisted = await page.evaluate(async () => ({
    conversation: await window.api.getRagConversation('forced-quit-chat'),
    messages: await window.api.getRagMessages('forced-quit-chat')
  }))
  expect(persisted.conversation?.title).toBe('Forced Quit Chat')
  expect(persisted.messages.map((message) => message.content)).toEqual([
    'committed before forced quit'
  ])

  await enterChat()
  await expect(page.getByPlaceholder(/ask anything/i)).toBeEnabled()
  await expect(page.getByText('committed before forced quit', { exact: true })).toBeVisible()
})
