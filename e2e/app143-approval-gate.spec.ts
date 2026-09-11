/**
 * APP-143 — a connector write cannot cross the external boundary before visible approval.
 *
 * The rendered app, preload, IPC handlers, encrypted SQLite connector repository, approval queue,
 * execution claim, lifecycle, audit log, and Actions UI are production code. The stdio MCP process
 * is the only fake: it stands in for an external provider and records the moment a write reaches it.
 */
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'

const PRO_PRESENT = fs.existsSync(path.resolve('pro/package.json'))
const MCP_SERVER = path.resolve('e2e/fixtures/app143-approval-connector.mjs')
const MODEL_SERVER = path.resolve('e2e/fixtures/app143-approval-llama-server.mjs')
const APPROVAL_TITLE = 'Create APP-143 release task'
const EXTERNAL_TITLE = 'Ship guarded approval journey'
const EXTERNAL_PROJECT = 'Desktop P0'

interface AuditEntry {
  action: string
  approval_id: number | null
}

interface App143RendererApi {
  mcpAdd: (connector: {
    name: string
    transport: 'stdio'
    command: string
    args: string[]
  }) => Promise<number>
  mcpTest: (id: number) => Promise<unknown>
  proInvoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  approvalsApprove: (id: number) => Promise<void>
  approvalsAudit: (limit: number) => Promise<AuditEntry[]>
}

let app: ElectronApplication | null = null
let page: Page
let profileDir: string
let executionLog: string

function installModelBoundary(): string {
  const binDir = path.join(profileDir, 'bin')
  const modelsDir = path.join(profileDir, 'models')
  const llamaDir = path.join(binDir, 'llama')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.mkdirSync(llamaDir, { recursive: true })
  const model = Buffer.alloc(2_048)
  model.write('GGUF')
  fs.writeFileSync(path.join(modelsDir, 'app143-local.gguf'), model)
  fs.writeFileSync(
    path.join(modelsDir, 'active-model.json'),
    JSON.stringify({ id: 'app143-local-model', primary: 'app143-local.gguf', mmproj: null })
  )
  const executable = path.join(llamaDir, 'llama-server')
  fs.copyFileSync(MODEL_SERVER, executable)
  fs.chmodSync(executable, 0o755)
  return binDir
}

const externalExecutions = (): Array<{ title: string; project: string }> => {
  if (!fs.existsSync(executionLog)) return []
  return fs
    .readFileSync(executionLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { title: string; project: string })
}

const approvalCard = (): Locator =>
  page
    .getByText(APPROVAL_TITLE, { exact: true })
    .locator('xpath=ancestor::div[contains(@class, "flex flex-col self-start")][1]')

test.beforeEach(async () => {
  test.skip(!PRO_PRESENT, 'pro package not present — approval execution is a Pro surface')
  test.skip(targetIsPackaged(), 'the scripted local-model boundary is for the source-built target')
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-app143-'))
  executionLog = path.join(profileDir, 'external-executions.jsonl')
  const binDir = installModelBoundary()
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profileDir,
      OFFGRID_BIN_DIR: binDir,
      OFFGRID_PRO: '1',
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
})

test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = null
  fs.rmSync(profileDir, { recursive: true, force: true })
})

test('holds a connector write until approval, then executes it once with visible outcome and audit', async () => {
  const testInfo = test.info()
  const connectorId = await page.evaluate(
    async ({ command, server, log }) =>
      (window as unknown as { api: App143RendererApi }).api.mcpAdd({
        name: 'APP-143 guarded connector',
        transport: 'stdio',
        command,
        args: [server, log]
      }),
    { command: process.execPath, server: MCP_SERVER, log: executionLog }
  )
  expect(connectorId).toEqual(expect.any(Number))

  const connection = await page.evaluate(
    (id) => (window as unknown as { api: App143RendererApi }).api.mcpTest(id),
    connectorId
  )
  expect(connection).toMatchObject({
    ok: true,
    tools: expect.arrayContaining([expect.objectContaining({ name: 'create_external_task' })])
  })

  // Connector tools are a per-Chat choice. Enable them through the shipped composer control before
  // opening the approval intake; the preference then follows the same execution Chat.
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  const dismiss = page.getByRole('button', { name: 'Dismiss', exact: true })
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click()
  await page.getByRole('button', { name: 'Composer options' }).click()
  await page.getByRole('menuitem', { name: /^Connectors/ }).click()
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Actions', exact: true }).click()
  await page.getByRole('button', { name: /^Approvals/ }).click()
  await expect(page.getByText('Nothing waiting for approval.')).toBeVisible()

  const approvalId = await page.evaluate(
    async ({ id, title, externalTitle, externalProject }) => {
      const api = (window as unknown as { api: App143RendererApi }).api
      return api.proInvoke('approvals:propose', {
        title,
        detail: 'Create exactly one external task after the user reviews this request.',
        connector: 'APP-143 guarded connector',
        connectorId: id,
        tool: 'create_external_task',
        args: { title: externalTitle, project: externalProject },
        entityName: 'Off Grid AI Desktop',
        source: 'APP-143 rendered E2E'
      }) as Promise<number>
    },
    {
      id: connectorId,
      title: APPROVAL_TITLE,
      externalTitle: EXTERNAL_TITLE,
      externalProject: EXTERNAL_PROJECT
    }
  )

  const pendingCard = approvalCard()
  await expect(pendingCard).toBeVisible()
  await expect(pendingCard.getByText('pending', { exact: true })).toBeVisible()
  await expect(
    pendingCard.getByText('APP-143 guarded connector · create_external_task')
  ).toBeVisible()
  await expect(pendingCard.getByRole('button', { name: 'Review in Chat' })).toBeVisible()

  await pendingCard.getByRole('button', { name: 'details' }).click()
  await expect(pendingCard.getByText(`"title": "${EXTERNAL_TITLE}"`)).toBeVisible()
  await expect(pendingCard.getByText(`"project": "${EXTERNAL_PROJECT}"`)).toBeVisible()
  expect(externalExecutions()).toEqual([])
  await page.screenshot({
    path: testInfo.outputPath('app143-pending-approval.png'),
    fullPage: true
  })

  await pendingCard.getByRole('button', { name: 'Review in Chat' }).click()
  const intake = page.getByTestId(`approval-intake-${approvalId}`)
  await expect(intake).toBeVisible()
  await expect(intake.getByLabel(/What should Off Grid AI do/)).toHaveValue(APPROVAL_TITLE)
  await expect(intake.getByLabel(/^title/)).toHaveValue(EXTERNAL_TITLE)
  await expect(intake.getByLabel(/^project/)).toHaveValue(EXTERNAL_PROJECT)
  expect(externalExecutions()).toEqual([])
  await intake.getByRole('button', { name: 'Start in chat' }).click()

  await expect(
    page.getByText('Created the external task once and verified the connector result.', {
      exact: true
    }).last()
  ).toBeVisible({ timeout: 90_000 })
  await expect
    .poll(externalExecutions, { message: 'external connector should execute exactly once' })
    .toEqual([{ title: EXTERNAL_TITLE, project: EXTERNAL_PROJECT }])

  await page.getByRole('button', { name: 'Actions', exact: true }).click()
  await page.getByRole('button', { name: /^Approvals/ }).click()
  await page.getByRole('button', { name: /^history/ }).click()

  const executedCard = approvalCard()
  await expect(executedCard.getByText('executed', { exact: true })).toBeVisible({ timeout: 10_000 })
  const visibleOutcome = executedCard.getByText(/Created external task/)
  if (!(await visibleOutcome.isVisible().catch(() => false))) {
    await executedCard.getByRole('button', { name: 'details' }).click()
  }
  await expect(visibleOutcome).toBeVisible()
  // A stale/repeated approval IPC cannot cross the connector boundary a second time because the
  // persisted pending→approved claim already belongs to the visible click above.
  await page.evaluate(
    (id) => (window as unknown as { api: App143RendererApi }).api.approvalsApprove(id),
    approvalId
  )
  expect(externalExecutions()).toEqual([{ title: EXTERNAL_TITLE, project: EXTERNAL_PROJECT }])

  const audit = await page.evaluate(async () =>
    (window as unknown as { api: App143RendererApi }).api.approvalsAudit(50)
  )
  expect(
    audit
      .filter((entry) => entry.approval_id === approvalId)
      .map((entry) => entry.action)
      .reverse()
  ).toEqual(['proposed', 'approved', 'executed'])

  await page.screenshot({
    path: testInfo.outputPath('app143-executed-approval.png'),
    fullPage: true
  })
})
