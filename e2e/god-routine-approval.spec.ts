/**
 * A God routine that tries to write through a connector waits for approval.
 *
 * Real app over two boundaries: the APP-143 stdio MCP connector, which records every write it
 * executes, and a fake llama-server that calls the connector's create_external_task when the
 * routine's instruction asks for it. The person adds a scheduled task in God settings and runs it
 * now. Nobody watches a routine, so the write must appear in Actions → Approvals and the
 * connector must stay untouched until it is approved. Approving runs it exactly once.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import { closeAndWait, gotoScreen, mainWindow } from './helpers/windows'

const PRO_PRESENT = fs.existsSync(path.resolve('pro/package.json'))
const MCP_SERVER = path.resolve('e2e/fixtures/app143-approval-connector.mjs')
const CONNECTOR = 'APP-143 guarded connector'
const ROUTINE = 'Release task filer'
const INSTRUCTION = 'File the guarded release task in Desktop P0.'
const EXTERNAL = { title: 'Ship guarded approval journey', project: 'Desktop P0' }
/** How the action engine names a held connector write. */
const HELD_WRITE = `create_external_task via ${CONNECTOR}`

interface ApprovalRow {
  id: number
  title: string
  status: string
}

interface RoutineApi {
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

const externalExecutions = (): Array<{ title: string; project: string }> =>
  fs.existsSync(executionLog)
    ? fs
        .readFileSync(executionLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { title: string; project: string })
    : []

const pendingConnectorApprovals = (): Promise<ApprovalRow[]> =>
  page.evaluate(async (title) => {
    const api = (window as unknown as { api: RoutineApi }).api
    const rows = (await api.proInvoke('approvals:list', 'pending')) as ApprovalRow[]
    return rows.filter((row) => row.title === title)
  }, HELD_WRITE)

test.describe('God routine approval', () => {
  test.skip(targetIsPackaged(), 'This native-model boundary is for the source-built E2E target.')

  test.beforeEach(async () => {
    test.skip(!PRO_PRESENT, 'pro package not present: God routines are a Pro surface')
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-god-routine-'))
    executionLog = path.join(profileDir, 'external-executions.jsonl')
    const modelsDir = path.join(profileDir, 'models')
    const llamaDir = path.join(profileDir, 'bin', 'llama')
    fs.mkdirSync(modelsDir, { recursive: true })
    fs.mkdirSync(llamaDir, { recursive: true })
    const gguf = Buffer.alloc(2048)
    gguf.write('GGUF')
    fs.writeFileSync(path.join(modelsDir, 'routine-local.gguf'), gguf)
    fs.writeFileSync(
      path.join(modelsDir, 'active-model.json'),
      JSON.stringify({ id: 'routine-local-model', primary: 'routine-local.gguf', mmproj: null })
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
    page = await mainWindow(app)
    await completeOnboarding(page)
  })

  test.afterEach(async () => {
    for (const name of ['model-requests.jsonl', 'external-executions.jsonl']) {
      const file = path.join(profileDir, name)
      if (fs.existsSync(file)) await test.info().attach(name, { path: file })
    }
    if (app) await closeAndWait(app)
    app = null
    fs.rmSync(profileDir, { recursive: true, force: true })
  })

  test("A routine's connector write waits in Approvals and runs once when approved", async () => {
    test.setTimeout(150_000)
    // The connector is the precondition, added the way Integrations saves it.
    const connectorId = await page.evaluate(
      async ({ command, server, log, name }) =>
        (window as unknown as { api: RoutineApi }).api.mcpAdd({
          name,
          transport: 'stdio',
          command,
          args: [server, log]
        }),
      { command: process.execPath, server: MCP_SERVER, log: executionLog, name: CONNECTOR }
    )
    expect(
      await page.evaluate(
        (id) => (window as unknown as { api: RoutineApi }).api.mcpTest(id),
        connectorId
      )
    ).toMatchObject({ ok: true })

    await gotoScreen(page, 'God')
    await page.getByRole('button', { name: 'God settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'God settings' })
    await settings
      .getByRole('button', { name: /^Scheduled tasks/ })
      .first()
      .click()
    await settings.getByRole('button', { name: 'Add a scheduled task', exact: true }).click()
    const form = settings.getByRole('form', { name: 'Add a scheduled task' })
    await form.getByPlaceholder('Morning brief').fill(ROUTINE)
    await form.getByPlaceholder(/^Brief me on my day/).fill(INSTRUCTION)
    await form.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(form).toBeHidden()

    await settings.getByRole('button', { name: `Run ${ROUTINE} now`, exact: true }).click()
    await expect
      .poll(async () => (await pendingConnectorApprovals()).length, {
        timeout: 60_000
      })
      .toBe(1)

    // The write is waiting where a person reviews it, and has not reached the connector.
    await page.getByRole('button', { name: 'Close God settings', exact: true }).click()
    await gotoScreen(page, 'Actions')
    await page.getByRole('radio', { name: /^Approvals/ }).click()
    await expect(page.getByRole('paragraph').filter({ hasText: HELD_WRITE })).toBeVisible()
    await page.waitForTimeout(1_000)
    expect(externalExecutions()).toEqual([])

    const [approval] = await pendingConnectorApprovals()
    await page.evaluate(
      (id) => (window as unknown as { api: RoutineApi }).api.approvalsApprove(id),
      approval!.id
    )
    await expect.poll(externalExecutions, { timeout: 30_000 }).toEqual([EXTERNAL])
    // A repeated approval cannot run it a second time.
    await page.evaluate(
      (id) => (window as unknown as { api: RoutineApi }).api.approvalsApprove(id),
      approval!.id
    )
    await page.waitForTimeout(1_000)
    expect(externalExecutions()).toEqual([EXTERNAL])
    await page.getByRole('radio', { name: 'history', exact: true }).click()
    await expect(page.getByText('executed', { exact: true }).first()).toBeVisible({
      timeout: 15_000
    })
  })
})
