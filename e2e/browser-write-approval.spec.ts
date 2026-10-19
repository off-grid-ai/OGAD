/**
 * A write asked for from the paired browser waits for approval on Desktop.
 *
 * Real app, bridge and action engine; the boundaries are the fake paired browser, the APP-143
 * stdio MCP connector (which records every write it executes), and a fake llama-server that calls
 * the connector's create_external_task when asked to file the release task. A page the browser
 * reads could ask the model for such a write, so nothing may reach the connector until a person
 * approves it on Desktop.
 *
 * Asserts: the write shows in Actions → Approvals and the connector stays untouched; Reject
 * cancels it for good; a second request runs exactly once when approved.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import { enginePortsUnavailableReason } from './helpers/ports'
import { pairedBrowser, type FakeExtension } from './helpers/fake-extension'
import { closeAndWait, gotoScreen, mainWindow } from './helpers/windows'

const PRO_PRESENT = fs.existsSync(path.resolve('pro/package.json'))
const MCP_SERVER = path.resolve('e2e/fixtures/app143-approval-connector.mjs')
const CONNECTOR = 'APP-143 guarded connector'
const ASK = 'File the guarded release task in Desktop P0.'
const HELD_WRITE = `create_external_task via ${CONNECTOR}`
const HELD_WRITE_IN_WORDS = `Create external task in ${CONNECTOR}`
const EXTERNAL = { title: 'Ship guarded approval journey', project: 'Desktop P0' }

interface ApprovalRow {
  id: number
  title: string
  status: string
}

interface ApprovalApi {
  mcpAdd: (connector: {
    name: string
    transport: 'stdio'
    command: string
    args: string[]
  }) => Promise<number>
  mcpTest: (id: number) => Promise<{ ok: boolean }>
  proInvoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  approvalsApprove: (id: number) => Promise<unknown>
}

let app: ElectronApplication | null = null
let page: Page
let profileDir: string
let executionLog: string
let browser: FakeExtension | null = null

const id = (): string => randomUUID().replace(/-/g, '')

const externalExecutions = (): Array<{ title: string; project: string }> =>
  fs.existsSync(executionLog)
    ? fs
        .readFileSync(executionLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { title: string; project: string })
    : []

const heldWrites = (status: string): Promise<ApprovalRow[]> =>
  page.evaluate(
    async ({ title, wanted }) => {
      const api = (window as unknown as { api: ApprovalApi }).api
      const rows = (await api.proInvoke('approvals:list', wanted)) as ApprovalRow[]
      return rows.filter((row) => row.title === title)
    },
    { title: HELD_WRITE, wanted: status }
  )

/** The browser asks, in Agent mode, for the write; resolves when its run has finished. */
const askFromBrowser = async (): Promise<void> => {
  const started = await browser!.rpc('chat.start', {
    runId: id(),
    conversationId: id(),
    prompt: ASK,
    mode: 'agent'
  })
  expect(started.ok, JSON.stringify(started)).toBe(true)
  const runId = (started.result as { runId: string }).runId
  await expect
    .poll(
      async () =>
        ((await browser!.rpc('chat.read', { runId, cursor: 0 })).result as { done: boolean }).done,
      { timeout: 60_000 }
    )
    .toBe(true)
}

test.describe('Paired-browser write approval', () => {
  test.skip(targetIsPackaged(), 'This native-model boundary is for the source-built E2E target.')

  test.beforeEach(async () => {
    test.skip(!PRO_PRESENT, 'pro package not present: approvals are a Pro surface')
    const busy = await enginePortsUnavailableReason()
    test.skip(busy !== null, busy ?? '')
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-browser-approval-'))
    executionLog = path.join(profileDir, 'external-executions.jsonl')
    const modelsDir = path.join(profileDir, 'models')
    const llamaDir = path.join(profileDir, 'bin', 'llama')
    fs.mkdirSync(modelsDir, { recursive: true })
    fs.mkdirSync(llamaDir, { recursive: true })
    const gguf = Buffer.alloc(2048)
    gguf.write('GGUF')
    fs.writeFileSync(path.join(modelsDir, 'approval-local.gguf'), gguf)
    fs.writeFileSync(
      path.join(modelsDir, 'active-model.json'),
      JSON.stringify({ id: 'approval-local-model', primary: 'approval-local.gguf', mmproj: null })
    )
    fs.copyFileSync(
      path.resolve('e2e/fixtures/app143-approval-llama-server.mjs'),
      path.join(llamaDir, 'llama-server')
    )
    fs.chmodSync(path.join(llamaDir, 'llama-server'), 0o755)
    app = await launchOffGrid({
      env: {
        ...process.env,
        OFFGRID_USER_DATA: profileDir,
        OFFGRID_BIN_DIR: path.join(profileDir, 'bin'),
        OFFGRID_APP143_MODEL_LOG: path.join(profileDir, 'model-requests.jsonl'),
        OFFGRID_PRO: '1',
        NODE_ENV: 'production',
        NO_PROXY: '127.0.0.1,localhost'
      }
    })
    page = await mainWindow(app)
    await completeOnboarding(page)
    const connectorId = await page.evaluate(
      async ({ command, server, log, name }) =>
        (window as unknown as { api: ApprovalApi }).api.mcpAdd({
          name,
          transport: 'stdio',
          command,
          args: [server, log]
        }),
      { command: process.execPath, server: MCP_SERVER, log: executionLog, name: CONNECTOR }
    )
    expect(
      await page.evaluate(
        (connector) => (window as unknown as { api: ApprovalApi }).api.mcpTest(connector),
        connectorId
      )
    ).toMatchObject({ ok: true })
    browser = await pairedBrowser(app)
  })

  test.afterEach(async () => {
    const log = path.join(profileDir, 'model-requests.jsonl')
    if (fs.existsSync(log)) await test.info().attach('model-requests.jsonl', { path: log })
    await browser?.close()
    browser = null
    if (app) await closeAndWait(app)
    app = null
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true })
  })

  test('A browser write waits for Desktop: Reject cancels it, Approve runs it once', async () => {
    test.setTimeout(180_000)
    await askFromBrowser()
    await expect.poll(async () => (await heldWrites('pending')).length, { timeout: 30_000 }).toBe(1)

    await gotoScreen(page, 'Actions')
    await page.getByRole('radio', { name: /^Approvals/ }).click()
    // Listed as the action in words, in the app it acts in; the tool id stays internal.
    const row = page
      .getByRole('table', { name: 'Approvals', exact: true })
      .getByRole('row')
      .filter({ hasText: HELD_WRITE_IN_WORDS })
    await expect(row).toBeVisible()
    await expect(row.getByRole('cell', { name: CONNECTOR, exact: true })).toBeVisible()
    await expect(row).not.toContainText('create_external_task')
    await page.waitForTimeout(1_000)
    expect(externalExecutions()).toEqual([])

    // Reject: it never runs.
    await row.getByRole('button', { name: 'Reject', exact: true }).click()
    // The reason form sits in the row beneath the request.
    await row
      .locator('xpath=following-sibling::tr[1]')
      .getByRole('button', { name: 'Dismiss', exact: true })
      .click()
    await expect
      .poll(async () => (await heldWrites('rejected')).length, { timeout: 15_000 })
      .toBe(1)
    await page.waitForTimeout(1_000)
    expect(externalExecutions()).toEqual([])

    // Asked again and approved: it runs exactly once.
    await askFromBrowser()
    await expect.poll(async () => (await heldWrites('pending')).length, { timeout: 30_000 }).toBe(1)
    expect(externalExecutions()).toEqual([])
    const [pending] = await heldWrites('pending')
    await page.evaluate(
      (approval) => (window as unknown as { api: ApprovalApi }).api.approvalsApprove(approval),
      pending!.id
    )
    await expect.poll(externalExecutions, { timeout: 30_000 }).toEqual([EXTERNAL])
    await page.waitForTimeout(1_000)
    expect(externalExecutions()).toEqual([EXTERNAL])
  })
})
