import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'

let app: ElectronApplication | null = null
let page: Page
let profileDir: string
let binDir: string
let auditFile: string

async function closeApp(): Promise<void> {
  const running = app
  if (!running) return
  app = null
  const child = running.process()
  await running.close()
  if (child.exitCode === null)
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))
}

async function launchApp(): Promise<void> {
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profileDir,
      OFFGRID_BIN_DIR: binDir,
      OFFGRID_CHAT_CONTROLS_AUDIT_FILE: auditFile,
      OFFGRID_PRO: '0',
      NODE_ENV: 'production',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      GOOGLE_API_KEY: '',
      HF_TOKEN: '',
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      ALL_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: '127.0.0.1,localhost'
    },
    extraArgs: ['--proxy-server=http://127.0.0.1:9']
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)
  await expect(async () => {
    await page.getByRole('button', { name: 'Chat', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible({
      timeout: 1_000
    })
  }).toPass({ timeout: 15_000 })
  // These journeys exercise message controls. Keep tool routing out of the
  // synthetic model contract through the same setting a user can change.
  await page.getByRole('button', { name: 'Composer options', exact: true }).click()
  const toolsOn = page.getByRole('menuitem', { name: 'Tools On', exact: true })
  if (await toolsOn.count()) await toolsOn.click()
  await expect(page.getByRole('menuitem', { name: 'Tools Off', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
}

const audit = (): Array<{
  event: string
  prompt: string
  messages?: Array<{ role: string; content: string }>
}> =>
  fs.existsSync(auditFile)
    ? fs
        .readFileSync(auditFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []

async function submit(prompt: string, key = 'Enter'): Promise<void> {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  await composer.fill(prompt)
  await composer.press(key)
  await expect(composer).toHaveValue('')
}

async function answer(text: string): Promise<void> {
  await expect(page.getByText(text, { exact: true }).last()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toBeHidden()
}

test.describe('Desktop queue and saved response versions', () => {
  test.skip(targetIsPackaged(), 'Uses a synthetic native model in the source-built app.')
  test.setTimeout(120_000)

  test.beforeEach(async () => {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-chat-controls-'))
    binDir = path.join(profileDir, 'bin')
    auditFile = path.join(profileDir, 'model-requests.jsonl')
    const modelsDir = path.join(profileDir, 'models')
    const llamaDir = path.join(binDir, 'llama')
    fs.mkdirSync(modelsDir, { recursive: true })
    fs.mkdirSync(llamaDir, { recursive: true })
    const model = Buffer.alloc(2_048)
    model.write('GGUF')
    fs.writeFileSync(path.join(modelsDir, 'chat-controls.gguf'), model)
    fs.writeFileSync(
      path.join(modelsDir, 'active-model.json'),
      JSON.stringify({
        id: 'chat-controls-local-model',
        primary: 'chat-controls.gguf',
        mmproj: null
      })
    )
    const executable = path.join(llamaDir, 'llama-server')
    fs.copyFileSync(
      path.join(process.cwd(), 'e2e/fixtures/chat-queue-versions-llama-server.mjs'),
      executable
    )
    fs.chmodSync(executable, 0o755)
    await launchApp()
  })

  // Playwright requires a destructured first parameter.
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    await closeApp()
    if (fs.existsSync(auditFile))
      fs.copyFileSync(auditFile, testInfo.outputPath('model-requests.jsonl'))
    const log = path.join(profileDir, 'logs', 'off-grid-ai-desktop.log')
    if (fs.existsSync(log)) fs.copyFileSync(log, testInfo.outputPath('desktop.log'))
    fs.rmSync(profileDir, { recursive: true, force: true })
  })

  test('Enter queues; the platform shortcut sends first and keeps both queued messages', async () => {
    await submit('Hold this reply open.')
    await expect(
      page.getByText('The first reply is still running.', { exact: true }).last()
    ).toBeVisible()
    await submit('Queue this first.')
    await submit('Queue this second.')
    await expect(page.getByText('2 queued', { exact: true })).toBeVisible()
    expect(
      audit()
        .filter((entry) => entry.event === 'request')
        .map((entry) => entry.prompt)
    ).toEqual(['Hold this reply open.'])

    await submit(
      'Send this ahead of the queue.',
      process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter'
    )
    await answer('The second queued reply is complete.')
    for (const text of [
      'The urgent reply is complete.',
      'The first queued reply is complete.',
      'The first reply is still running.'
    ]) {
      await expect(page.getByText(text, { exact: true }).last()).toBeVisible()
    }
    await expect(page.getByText('UNEXPECTED UNINTERRUPTED TAIL.', { exact: false })).toHaveCount(0)
    await expect(page.getByText('2 queued', { exact: true })).toBeHidden()
    expect(
      audit()
        .filter((entry) => entry.event === 'request')
        .map((entry) => entry.prompt)
    ).toEqual([
      'Hold this reply open.',
      'Send this ahead of the queue.',
      'Queue this first.',
      'Queue this second.'
    ])
    const requests = audit().filter((entry) => entry.event === 'request')
    for (const [index, precedingAnswer] of [
      [1, 'The first reply is still running.'],
      [2, 'The urgent reply is complete.'],
      [3, 'The first queued reply is complete.']
    ] as const) {
      expect(requests[index].messages).toContainEqual({
        role: 'assistant',
        content: precedingAnswer
      })
    }
    expect(
      audit()
        .filter((entry) => entry.event === 'cancelled')
        .map((entry) => entry.prompt)
    ).toEqual(['Hold this reply open.'])
  })

  test('resend and regenerate keep versions; edit starts a new branch after restart', async () => {
    await submit('Keep each response version.')
    await answer('Original answer version 1.')
    await page.getByRole('button', { name: 'Message actions', exact: true }).first().click()
    await page.getByRole('menuitem', { name: 'Resend', exact: true }).click()
    await answer('Original answer version 2.')
    await expect(page.getByText('2/2', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Previous response' }).click()
    await expect(page.getByText('1/2', { exact: true })).toBeVisible()
    await expect(page.getByText('Original answer version 1.', { exact: true }).last()).toBeVisible()
    await page.getByRole('button', { name: 'Next response' }).click()
    await page.getByRole('button', { name: 'Message actions', exact: true }).last().click()
    await page.getByRole('menuitem', { name: 'Regenerate', exact: true }).click()
    await answer('Original answer version 3.')
    await expect(page.getByText('3/3', { exact: true })).toBeVisible()
    await submit('Add a later turn.')
    await answer('The later answer will be removed by the edit.')

    await page.getByRole('button', { name: 'Message actions', exact: true }).first().click()
    await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()
    await page.locator('textarea:not([placeholder])').fill('Keep the edited response too.')
    await page.getByRole('button', { name: 'Save & submit', exact: true }).click()
    await answer('Edited answer version 4.')
    await expect(page.getByRole('button', { name: 'Previous response' })).toHaveCount(0)
    await expect(
      page.getByText('The later answer will be removed by the edit.', { exact: true })
    ).toHaveCount(0)
    expect(
      audit()
        .filter((entry) => entry.event === 'request')
        .at(-1)?.messages
    ).toEqual([{ role: 'user', content: 'Keep the edited response too.' }])
    await closeApp()
    await launchApp()
    await expect(page.getByRole('button', { name: 'Previous response' })).toHaveCount(0)
    await expect(page.getByText('Original answer version 3.', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Edited answer version 4.', { exact: true }).last()).toBeVisible()
  })

  test('keeps the saved answer when the app closes during resend', async () => {
    await submit('Keep the saved answer during retry.')
    await answer('The saved answer remains available.')
    await page.getByRole('button', { name: 'Message actions', exact: true }).first().click()
    await page.getByRole('menuitem', { name: 'Resend', exact: true }).click()
    await expect(
      page.getByText('The replacement reply is still running.', { exact: true }).last()
    ).toBeVisible()
    await closeApp()
    await launchApp()
    const previous = page.getByRole('button', { name: 'Previous response' })
    if ((await previous.count()) && (await previous.isEnabled())) await previous.click()
    await expect(
      page.getByText('The saved answer remains available.', { exact: true }).last()
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toBeHidden()
  })

  test('Stop during resend keeps both the partial and earlier answer after restart', async () => {
    await submit('Keep the saved answer during retry.')
    await answer('The saved answer remains available.')
    await page.getByRole('button', { name: 'Message actions', exact: true }).first().click()
    await page.getByRole('menuitem', { name: 'Resend', exact: true }).click()
    await expect(
      page.getByText('The replacement reply is still running.', { exact: true }).last()
    ).toBeVisible()
    await page.getByRole('button', { name: 'Stop generating', exact: true }).click()
    await expect(page.getByText('2/2', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Previous response' }).click()
    await expect(
      page.getByText('The saved answer remains available.', { exact: true }).last()
    ).toBeVisible()
    await closeApp()
    await launchApp()
    await expect(page.getByText('1/2', { exact: true })).toBeVisible()
    await expect(
      page.getByText('The saved answer remains available.', { exact: true }).last()
    ).toBeVisible()
    await page.getByRole('button', { name: 'Next response' }).click()
    await expect(
      page.getByText('The replacement reply is still running.', { exact: true }).last()
    ).toBeVisible()
  })

  test('a failed resend keeps the earlier answer available', async () => {
    await submit('Keep the saved answer after failure.')
    await answer('The saved answer before failure remains available.')
    await page.getByRole('button', { name: 'Message actions', exact: true }).first().click()
    await page.getByRole('menuitem', { name: 'Resend', exact: true }).click()
    await expect(page.getByText('1/2', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toBeHidden()
    await page.getByRole('button', { name: 'Next response' }).click()
    await expect(page.getByText('2/2', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Previous response' }).click()
    await expect(
      page.getByText('The saved answer before failure remains available.', { exact: true }).last()
    ).toBeVisible()
  })

  test('a queued reply in another chat does not clear the current draft', async () => {
    await submit('Finish while I prepare another chat.')
    await expect(
      page.getByText('The background reply started.', { exact: true }).last()
    ).toBeVisible()
    await submit('Queue this first.')
    await page.getByRole('button', { name: 'New chat', exact: true }).click()
    const composer = page.getByRole('textbox', { name: 'Message', exact: true })
    await composer.fill('Keep this unsent draft in the second chat.')
    await expect
      .poll(() =>
        audit()
          .filter((entry) => entry.event === 'request')
          .map((entry) => entry.prompt)
      )
      .toEqual(['Finish while I prepare another chat.', 'Queue this first.'])
    await expect(composer).toHaveValue('Keep this unsent draft in the second chat.')
    await expect(
      page
        .getByTestId(/^chat-message-/)
        .getByText('The first queued reply is complete.', { exact: true })
    ).toHaveCount(0)
    await page
      .getByRole('button', { name: /^Finish while I prepare another chat\. Conversation actions/ })
      .click()
    await answer('The first queued reply is complete.')
    expect(
      audit()
        .filter((entry) => entry.event === 'request')
        .at(-1)?.messages
    ).toContainEqual({
      role: 'assistant',
      content: 'The background reply started. The background reply is complete.'
    })
  })

  test('ordinary Stop cancels both queued drafts before the next send', async () => {
    await submit('Hold this reply open.')
    await expect(
      page.getByText('The first reply is still running.', { exact: true }).last()
    ).toBeVisible()
    await submit('Queue this first.')
    await submit('Queue this second.')
    await expect(page.getByText('2 queued', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Stop generating', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toBeHidden()
    await expect(page.getByText('2 queued', { exact: true })).toBeHidden()
    await submit('Send this ahead of the queue.')
    await answer('The urgent reply is complete.')
    expect(
      audit()
        .filter((entry) => entry.event === 'request')
        .map((entry) => entry.prompt)
    ).toEqual(['Hold this reply open.', 'Send this ahead of the queue.'])
    await expect(
      page.getByText('The first queued reply is complete.', { exact: true })
    ).toHaveCount(0)
    await expect(
      page.getByText('The second queued reply is complete.', { exact: true })
    ).toHaveCount(0)
  })

  test('the selected older answer is sent as context before and after restart', async () => {
    await submit('Keep each response version.')
    await answer('Original answer version 1.')
    await page.getByRole('button', { name: 'Message actions', exact: true }).first().click()
    await page.getByRole('menuitem', { name: 'Resend', exact: true }).click()
    await answer('Original answer version 2.')
    await page.getByRole('button', { name: 'Previous response' }).click()
    await expect(page.getByText('1/2', { exact: true })).toBeVisible()
    await submit('Add a later turn.')
    await answer('The later answer will be removed by the edit.')
    expect(
      audit()
        .filter((entry) => entry.event === 'request')
        .at(-1)?.messages
    ).toContainEqual({
      role: 'assistant',
      content: 'Original answer version 1.'
    })
    await closeApp()
    await launchApp()
    await expect(page.getByText('1/2', { exact: true })).toBeVisible()
    await submit('Send this ahead of the queue.')
    await answer('The urgent reply is complete.')
    const messages = audit()
      .filter((entry) => entry.event === 'request')
      .at(-1)?.messages
    expect(messages).toContainEqual({ role: 'assistant', content: 'Original answer version 1.' })
    expect(messages).not.toContainEqual({
      role: 'assistant',
      content: 'Original answer version 2.'
    })
  })

  for (const sendNow of [false, true]) {
    test(`reattached chat drains saved history and queued drafts${sendNow ? ' with Send Now first' : ' after natural completion'}`, async () => {
      const held = sendNow ? 'Hold this reply open.' : 'Finish after I reopen Chat.'
      await submit(held)
      await expect(
        page.getByText('The first reply is still running.', { exact: true }).last()
      ).toBeVisible()
      await submit('Queue this first.')
      await expect(page.getByText('1 queued', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Settings', exact: true }).first().click()
      await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
      await page.getByRole('button', { name: 'Chat', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toBeVisible()
      await expect(page.getByText('1 queued', { exact: true })).toBeVisible()
      await submit('Queue this second.')
      await page.getByRole('button', { name: 'Settings', exact: true }).first().click()
      await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
      await page.getByRole('button', { name: 'Chat', exact: true }).click()
      await expect(page.getByText('2 queued', { exact: true })).toBeVisible()
      if (sendNow)
        await submit(
          'Send this ahead of the queue.',
          process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter'
        )
      await answer('The second queued reply is complete.')
      const requests = audit().filter((entry) => entry.event === 'request')
      expect(requests.map((entry) => entry.prompt)).toEqual([
        held,
        ...(sendNow ? ['Send this ahead of the queue.'] : []),
        'Queue this first.',
        'Queue this second.'
      ])
      expect(requests[1].messages).toContainEqual({
        role: 'assistant',
        content: sendNow
          ? 'The first reply is still running.'
          : 'The first reply is still running. The reopened reply is complete.'
      })
      expect(requests.at(-1)?.messages).toContainEqual({
        role: 'assistant',
        content: 'The first queued reply is complete.'
      })
      await closeApp()
      await launchApp()
      await answer('The second queued reply is complete.')
      await expect(
        page
          .getByTestId(/^chat-message-/)
          .getByText('The first queued reply is complete.', { exact: true })
      ).toHaveCount(1)
    })
  }

  test('ordinary Stop after remount saves one partial answer and clears both queued drafts', async () => {
    await submit('Hold this reply open.')
    await expect(
      page.getByText('The first reply is still running.', { exact: true }).last()
    ).toBeVisible()
    await submit('Queue this first.')
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click()
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
    await page.getByRole('button', { name: 'Chat', exact: true }).click()
    await expect(page.getByText('1 queued', { exact: true })).toBeVisible()
    await submit('Queue this second.')
    await page.getByRole('button', { name: 'Stop generating', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toBeHidden()
    await submit('Send this ahead of the queue.')
    await answer('The urgent reply is complete.')
    expect(
      audit()
        .filter((entry) => entry.event === 'request')
        .map((entry) => entry.prompt)
    ).toEqual(['Hold this reply open.', 'Send this ahead of the queue.'])
    await closeApp()
    await launchApp()
    await expect(
      page
        .getByTestId(/^chat-message-/)
        .getByText('The first reply is still running.', { exact: true })
    ).toHaveCount(1)
    await answer('The urgent reply is complete.')
    await expect(
      page.getByText('The first queued reply is complete.', { exact: true })
    ).toHaveCount(0)
    await expect(
      page.getByText('The second queued reply is complete.', { exact: true })
    ).toHaveCount(0)
  })
})
