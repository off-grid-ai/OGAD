/**
 * APP-143 — a connector write cannot cross the external boundary before visible approval.
 *
 * The rendered app, preload, IPC handlers, encrypted SQLite connector repository, approval queue,
 * execution claim, lifecycle, audit log, and Actions UI are production code. Fakes stand only at
 * the native model server and external MCP provider boundaries.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid } from './helpers/launch'

const PRO_PRESENT = fs.existsSync(path.resolve('pro/package.json'))
const MCP_SERVER = path.resolve('e2e/fixtures/app143-approval-connector.mjs')
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

const externalExecutions = (): Array<{ title: string; project: string }> => {
  if (!fs.existsSync(executionLog)) return []
  return fs
    .readFileSync(executionLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { title: string; project: string })
}

test.beforeEach(async () => {
  test.skip(!PRO_PRESENT, 'pro package not present — approval execution is a Pro surface')
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-app143-'))
  executionLog = path.join(profileDir, 'external-executions.jsonl')
  const modelsDir = path.join(profileDir, 'models')
  const llamaDir = path.join(profileDir, 'bin', 'llama')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.mkdirSync(llamaDir, { recursive: true })
  const gguf = Buffer.alloc(2048)
  gguf.write('GGUF')
  fs.writeFileSync(path.join(modelsDir, 'app143-local.gguf'), gguf)
  fs.writeFileSync(
    path.join(modelsDir, 'active-model.json'),
    JSON.stringify({ id: 'app143-local-model', primary: 'app143-local.gguf', mmproj: null })
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
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)
})

test.afterEach(async () => {
  for (const name of [
    'model-requests.jsonl',
    'external-executions.jsonl',
    'logs/off-grid-ai-desktop.log'
  ]) {
    const file = path.join(profileDir, name)
    if (fs.existsSync(file)) await test.info().attach(name, { path: file })
  }
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

  // Connector tools are opt-in in Chat, including turns started by the approval form.
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  await page.getByRole('button', { name: 'Composer options', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Connectors Off', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Connectors On', exact: true })).toBeVisible()
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

  // This fresh profile contains one proposal, so the visible controls are unique.
  await expect(page.getByRole('paragraph').filter({ hasText: APPROVAL_TITLE })).toBeVisible()
  const pendingLabels = page.getByText('pending', { exact: true })
  // The pending filter and the proposal's status must both be visible.
  await expect(pendingLabels).toHaveCount(2)
  for (const label of await pendingLabels.all()) await expect(label).toBeVisible()
  await expect(page.getByText('APP-143 guarded connector · create_external_task')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Review in Chat', exact: true })).toBeVisible()

  // The proposal has traversed production IPC and is visibly waiting in the real queue. Give the
  // external boundary time to expose any accidental eager execution before asserting it stayed shut.
  await page.waitForTimeout(750)
  expect(externalExecutions()).toEqual([])
  await page.screenshot({
    path: testInfo.outputPath('app143-pending-approval.png'),
    fullPage: true
  })

  await page.getByRole('button', { name: 'details' }).click()
  await expect(page.getByText(`"title": "${EXTERNAL_TITLE}"`)).toBeVisible()
  await expect(page.getByText(`"project": "${EXTERNAL_PROJECT}"`)).toBeVisible()

  await page.getByRole('button', { name: 'Review in Chat', exact: true }).click()
  // Pro 99146f6 and core ca04e4f8b route local approvals through this Chat form.
  // ExecutionChatCard also opens this form; only remote cards still say Approve.
  const review = page.getByRole('form', { name: 'Add the final details, then start it in Chat' })
  await expect(review).toBeVisible()
  await expect(
    review.getByRole('textbox', { name: 'What should Off Grid AI do? *', exact: true })
  ).toHaveValue(APPROVAL_TITLE)
  await expect(review.getByRole('textbox', { name: 'title *', exact: true })).toHaveValue(
    EXTERNAL_TITLE
  )
  await expect(review.getByRole('textbox', { name: 'project *', exact: true })).toHaveValue(
    EXTERNAL_PROJECT
  )
  await page.waitForTimeout(750)
  expect(externalExecutions()).toEqual([])
  await review.getByRole('button', { name: 'Start in chat', exact: true }).click()
  await expect(review).toBeHidden()

  await expect
    .poll(externalExecutions, {
      message: 'approved Chat turn reaches the connector',
      timeout: 30_000
    })
    .toEqual([{ title: EXTERNAL_TITLE, project: EXTERNAL_PROJECT }])

  await page.getByRole('button', { name: 'Actions', exact: true }).click()
  await page.getByRole('button', { name: /^Approvals/ }).click()
  await page.getByRole('button', { name: 'history', exact: true }).click()

  await expect(page.getByRole('paragraph').filter({ hasText: APPROVAL_TITLE })).toBeVisible()
  await expect(page.getByText('executed', { exact: true })).toBeVisible({ timeout: 10_000 })
  const visibleOutcome = page.getByText(/Created external task/)
  if (!(await visibleOutcome.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'details' }).click()
  }
  await expect(visibleOutcome).toBeVisible()
  await expect
    .poll(externalExecutions, { message: 'external connector should execute exactly once' })
    .toEqual([{ title: EXTERNAL_TITLE, project: EXTERNAL_PROJECT }])

  // A stale/repeated approval IPC cannot cross the connector boundary a second time because the
  // persisted pending→approved claim already belongs to the visible click above.
  await page.evaluate(
    (id) => (window as unknown as { api: App143RendererApi }).api.approvalsApprove(id),
    approvalId
  )
  const repeatedChatApproval = await page.evaluate(
    (id) =>
      (window as unknown as { api: App143RendererApi }).api.proInvoke(
        'approvals:approve-for-chat',
        id
      ),
    approvalId
  )
  expect(repeatedChatApproval).toBe(false)
  await page.waitForTimeout(500)
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
