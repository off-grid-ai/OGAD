/**
 * Fresh-install smoke test. Launches the REAL built Electron app against an empty
 * userData dir (the same OFFGRID_USER_DATA trick used for manual fresh-install
 * testing) and drives onboarding → app shell, asserting on the DOM. OFFGRID_PRO=0
 * forces deterministic free-tier behavior (no capture-permission gate).
 *
 * Catches the most common release-breakers: boot crash, white screen, broken
 * preload (window.api), and onboarding/routing regressions. No model download —
 * a fresh dir has no model, so llama-server never spawns (fast + offline).
 *
 * Requires a build first: `npm run build` (the test:e2e script does this).
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchOffGrid } from './helpers/launch'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { enginePortsUnavailableReason } from './helpers/ports'

let app: ElectronApplication
let page: Page
let userDataDir: string
// Two tests below assert against the FIXED engine ports, which are single-owner. Resolved
// once, before any app launch (launching binds them), so those tests can skip honestly
// instead of failing against another process's gateway. See helpers/ports.ts.
let enginePortsBlocked: string | null = null

test.beforeAll(async () => {
  enginePortsBlocked = await enginePortsUnavailableReason()
})

test.beforeEach(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-e2e-'))
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir, // pristine first-run
      OFFGRID_PRO: '0', // deterministic unlicensed build (no permission gate)
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})

test.afterEach(async () => {
  await app?.close()
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

test('boots fresh without a white screen and exposes the preload bridge', async () => {
  // Renderer mounted with real content (not a blank/crashed page).
  await expect(page.locator('#root')).not.toBeEmpty()
  // Preload contextBridge is wired.
  const hasApi = await page.evaluate(() => typeof (window as { api?: unknown }).api === 'object')
  expect(hasApi).toBe(true)
})

test('opens filling the screen, not in a small window', async () => {
  // A dense desktop app has to open at desktop size. At the old 900x670 default the Models grid
  // collapsed to one card per row and the chat history rail ate a third of the width - every screen
  // read as a phone layout stretched wide.
  //
  // Asserted against the work area rather than a fixed size, so this holds on any display: filling
  // what the user can actually use, below the menu bar and beside the Dock. isMaximized() as well as
  // the size, because that is what keeps the window filled when the display changes rather than
  // leaving it merely large.
  const layout = await app.evaluate(async ({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0]!
    return {
      maximized: window.isMaximized(),
      bounds: window.getBounds(),
      workArea: screen.getPrimaryDisplay().workAreaSize
    }
  })

  expect(layout.maximized).toBe(true)
  expect(layout.bounds.width).toBe(layout.workArea.width)
  expect(layout.bounds.height).toBe(layout.workArea.height)
})

test('shows onboarding on a fresh install', async () => {
  await expect(page.getByText(/Off Grid/i).first()).toBeVisible()
  await expect(page.getByRole('button', { name: /Continue|Start using Off Grid/i })).toBeVisible()
})

test('onboarding surfaces the Pro capability grid', async () => {
  // Advance until the Pro step renders its capability cards, then assert a few
  // capabilities are shown by name (Replay, Meetings, Vault). Regression guard
  // for the onboarding redesign that showcases the Pro layer.
  const btn = page.getByRole('button', { name: /Continue|Start using Off Grid/i })
  for (let i = 0; i < 6; i++) {
    if (
      await page
        .getByText('Meetings')
        .isVisible()
        .catch(() => false)
    )
      break
    if (!(await btn.isVisible().catch(() => false))) break
    await btn.click()
    await page.waitForTimeout(400)
  }
  await expect(page.getByText('Replay')).toBeVisible()
  await expect(page.getByText('Meetings')).toBeVisible()
  await expect(page.getByText('Vault')).toBeVisible()
  await page.screenshot({ path: 'e2e/screenshots/onboarding-pro-grid.png' })
})

test('completes onboarding and lands in the app shell', async () => {
  // Click through every onboarding step (Continue × N, then "Start using Off Grid").
  for (let i = 0; i < 6; i++) {
    const btn = page.getByRole('button', { name: /Continue|Start using Off Grid/i })
    if (!(await btn.isVisible().catch(() => false))) break
    await btn.click()
    await page.waitForTimeout(400)
  }
  // Free tier defaults to the Models screen — assert the app shell rendered.
  await expect(page.getByRole('heading', { name: 'Models' })).toBeVisible()
})

test('system:health IPC returns the component list', async () => {
  // Asserts llama-server is UNREACHABLE on a fresh profile — a foreign llama-server on the
  // fixed port inverts that, so do not pretend to test it.
  test.skip(enginePortsBlocked !== null, enginePortsBlocked ?? '')
  const health = await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (window as any).api?.systemHealth?.()
  })
  expect(health).toBeTruthy()
  expect(Array.isArray(health.components)).toBe(true)
  // The chat + gateway components are always reported.
  const ids = health.components.map((c: { id: string }) => c.id)
  expect(ids).toContain('chat')
  expect(ids).toContain('gateway')

  let gateway: { modalities?: Record<string, string> } = {}
  await expect
    .poll(
      async () => {
        try {
          const response = await fetch('http://127.0.0.1:7878/health')
          if (!response.ok) return false
          gateway = await response.json()
          return true
        } catch {
          return false
        }
      },
      // Generous because a PACKAGED cold start brings the gateway up noticeably slower than
      // the dev build: the equivalent check in packaged-app-smoke.spec.ts needs ~24s, so a 10s
      // budget failed against the real .app while the gateway was merely still starting.
      { timeout: 30_000 }
    )
    .toBe(true)

  const byId = new Map(
    health.components.map((component: { id: string; status: string }) => [component.id, component])
  )
  expect(health.activeModel).toBeNull()
  expect(byId.get('gateway')?.status).toBe('ready')
  expect(byId.get('chat')?.status).toBe('not_installed')
  const llamaReachable = await fetch('http://127.0.0.1:8439/health')
    .then((response) => response.ok)
    .catch(() => false)
  expect(llamaReachable).toBe(false)

  const gatewayBackedComponents = {
    vision: 'vision_understanding',
    embeddings: 'embeddings',
    transcription: 'transcription',
    speech: 'speech'
  }
  for (const [componentId, modalityId] of Object.entries(gatewayBackedComponents)) {
    expect(byId.get(componentId)?.status).toBe(gateway.modalities?.[modalityId])
  }
  expect(byId.get('image')?.status).toBe(gateway.modalities?.image_generation)
})

test('gateway /v1/models serves active local models with modality metadata', async () => {
  // Polls the fixed gateway port for THIS app's fixture model; another owner never serves it.
  test.skip(enginePortsBlocked !== null, enginePortsBlocked ?? '')
  const modelsDir = path.join(userDataDir, 'models')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.writeFileSync(path.join(modelsDir, 'e2e-active.gguf'), 'synthetic gateway model fixture')
  fs.writeFileSync(
    path.join(modelsDir, 'active-model.json'),
    JSON.stringify({ id: 'e2e-active-model', primary: 'e2e-active.gguf', mmproj: null })
  )

  let catalog: {
    object?: string
    data?: Array<{ id?: string; object?: string; kind?: string }>
    models?: Array<{ name?: string; model?: string; kind?: string }>
  } = {}
  await expect
    .poll(
      async () => {
        try {
          const response = await fetch('http://127.0.0.1:7878/v1/models')
          if (!response.ok) return false
          catalog = await response.json()
          return catalog.data?.some((model) => model.id === 'e2e-active-model') ?? false
        } catch {
          return false
        }
      },
      // Generous because a PACKAGED cold start brings the gateway up noticeably slower than
      // the dev build: the equivalent check in packaged-app-smoke.spec.ts needs ~24s, so a 10s
      // budget failed against the real .app while the gateway was merely still starting.
      { timeout: 30_000 }
    )
    .toBe(true)

  expect(catalog.object).toBe('list')
  expect(catalog.data).toContainEqual(
    expect.objectContaining({
      id: 'e2e-active-model',
      object: 'model',
      kind: 'chat'
    })
  )
  expect(catalog.models).toContainEqual(
    expect.objectContaining({
      name: 'e2e-active-model',
      model: 'e2e-active-model',
      kind: 'chat'
    })
  )
})
