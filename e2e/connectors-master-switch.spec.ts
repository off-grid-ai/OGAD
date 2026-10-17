/**
 * Settings → Connectors → Enable connectors turns every connector off at once, like Tools.
 *
 * Real app over two boundaries: a stdio MCP connector (the APP-143 fixture) and a fake
 * llama-server that records every request. The rendered chat sends a turn with Connectors on;
 * the model must be offered the connector's tools. After the master switch is turned off in
 * Settings, the next turn must offer none, and the switch stays off after a relaunch.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid } from './helpers/launch'

const PRO_PRESENT = fs.existsSync(path.resolve('pro/package.json'))
const MCP_SERVER = path.resolve('e2e/fixtures/app143-approval-connector.mjs')
const CONNECTOR = 'Master switch connector'

interface ConnectorApi {
  mcpAdd: (connector: {
    name: string
    transport: 'stdio'
    command: string
    args: string[]
  }) => Promise<number>
  mcpTest: (id: number) => Promise<unknown>
}

let app: ElectronApplication | null = null
let page: Page
let profileDir: string
let modelLog: string

const launch = async (): Promise<void> => {
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profileDir,
      OFFGRID_BIN_DIR: path.join(profileDir, 'bin'),
      OFFGRID_APP143_MODEL_LOG: modelLog,
      OFFGRID_PRO: '1',
      NODE_ENV: 'production'
    }
  })
  await app.firstWindow()
  page = await mainWindow(app)
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)
}

/** The app's main window. Pro also opens utility windows (the clipboard popup), and after a
 *  relaunch one of those can be the first to appear. */
const mainWindow = async (running: ElectronApplication): Promise<Page> => {
  let found: Page | undefined
  await expect
    .poll(
      async () => {
        for (const candidate of running.windows()) {
          const url = candidate.url()
          if (url && !/#(clip-popup|cu-supervisor|ai-activity)|overlay/.test(url)) {
            found = candidate
            return true
          }
        }
        return false
      },
      { timeout: 30_000 }
    )
    .toBe(true)
  return found!
}

/** The connector tool names offered in the model request for this question. */
const offeredConnectorTools = (question: string): string[] => {
  const requests = fs
    .readFileSync(modelLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          messages?: { role: string; content: unknown }[]
          tools?: { function?: { name?: string } }[]
        }
    )
  const turn = requests.find((request) =>
    (request.messages ?? []).some(
      (message) => message.role === 'user' && JSON.stringify(message.content).includes(question)
    )
  )
  if (!turn) throw new Error(`No model request carried "${question}"`)
  return (turn.tools ?? [])
    .map((tool) => tool.function?.name ?? '')
    .filter((name) => name.startsWith('mcp__'))
}

const ask = async (question: string): Promise<void> => {
  const composer = page.getByRole('textbox', { name: 'Message' })
  await composer.fill(question)
  await composer.press('Enter')
  // The model received this turn, and the answer finished.
  await expect
    .poll(() => fs.existsSync(modelLog) && fs.readFileSync(modelLog, 'utf8').includes(question), {
      timeout: 60_000
    })
    .toBe(true)
  await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toBeHidden({
    timeout: 60_000
  })
}

const openConnectorSettings = async (): Promise<void> => {
  // Chat carries the Active models button; a relaunch opens on Day.
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  await page.getByRole('button', { name: 'Active models' }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).last().click()
  await page.getByRole('radio', { name: /connectors/i }).click()
}

// At file scope, so a non-Pro checkout skips before the hooks run (afterEach reads profileDir).
test.skip(!PRO_PRESENT, 'pro package not present — connectors are a Pro surface')

test.beforeEach(async () => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-connectors-switch-'))
  modelLog = path.join(profileDir, 'model-requests.jsonl')
  const modelsDir = path.join(profileDir, 'models')
  const llamaDir = path.join(profileDir, 'bin', 'llama')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.mkdirSync(llamaDir, { recursive: true })
  const gguf = Buffer.alloc(2048)
  gguf.write('GGUF')
  fs.writeFileSync(path.join(modelsDir, 'connectors-local.gguf'), gguf)
  fs.writeFileSync(
    path.join(modelsDir, 'active-model.json'),
    JSON.stringify({ id: 'connectors-local-model', primary: 'connectors-local.gguf', mmproj: null })
  )
  fs.copyFileSync(
    path.resolve('e2e/fixtures/app143-approval-llama-server.mjs'),
    path.join(llamaDir, 'llama-server')
  )
  fs.chmodSync(path.join(llamaDir, 'llama-server'), 0o755)
  await launch()
})

test.afterEach(async () => {
  for (const name of ['model-requests.jsonl', 'logs/off-grid-ai-desktop.log']) {
    const file = path.join(profileDir, name)
    if (fs.existsSync(file)) await test.info().attach(name, { path: file })
  }
  await app?.close().catch(() => undefined)
  app = null
  fs.rmSync(profileDir, { recursive: true, force: true })
})

test('Enable connectors off stops every connector tool reaching the model, and stays off', async () => {
  // Two launches and two chat turns.
  test.setTimeout(180_000)
  const connectorId = await page.evaluate(
    async ({ name, command, server, log }) =>
      (window as unknown as { api: ConnectorApi }).api.mcpAdd({
        name,
        transport: 'stdio',
        command,
        args: [server, log]
      }),
    {
      name: CONNECTOR,
      command: process.execPath,
      server: MCP_SERVER,
      log: path.join(profileDir, 'external-executions.jsonl')
    }
  )
  await expect
    .poll(() =>
      page.evaluate(
        async (id) => (window as unknown as { api: ConnectorApi }).api.mcpTest(id),
        connectorId
      )
    )
    .toMatchObject({ ok: true })

  // Connectors are opt-in per chat; with them on, the connector's tools reach the model.
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  await page.getByRole('button', { name: 'Composer options', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Connectors Off', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Connectors On', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await ask('Which connector tools can you use right now?')
  expect(offeredConnectorTools('Which connector tools can you use right now?')).toContain(
    `mcp__${connectorId}__create_external_task`
  )

  // The master switch in Settings turns every connector off, the chat's own toggle aside.
  await openConnectorSettings()
  const master = page.getByRole('switch', { name: 'Enable connectors', exact: true })
  await expect(master).toBeChecked()
  await master.click()
  await expect(master).not.toBeChecked()
  await page.keyboard.press('Escape')

  await ask('With connectors switched off, which connector tools remain?')
  expect(
    offeredConnectorTools('With connectors switched off, which connector tools remain?')
  ).toEqual([])

  // The choice is saved: after a relaunch the switch is still off.
  // Relaunch only once the first instance has exited: a second instance would hit the
  // single-instance lock and quit.
  const running = app!
  const child = running.process()
  await running.close()
  await expect.poll(() => child.exitCode ?? child.signalCode, { timeout: 30_000 }).not.toBeNull()
  app = null
  await launch()
  await openConnectorSettings()
  await expect(
    page.getByRole('switch', { name: 'Enable connectors', exact: true })
  ).not.toBeChecked()
})
