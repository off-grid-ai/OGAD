import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchOffGrid } from './helpers/launch'
import { completeOnboarding } from './helpers/onboarding'
import { gotoSettings, openSettingsSection } from './helpers/settings'

let app: ElectronApplication
let page: Page
let userDataDir: string

const visibleLayoutWidth = (): Promise<number> =>
  page.evaluate(() => document.documentElement.clientWidth)
const zoomModifier = process.platform === 'darwin' ? 'Meta' : 'Control'

async function zoom(action: 'Zoom In' | 'Zoom Out' | 'Actual Size'): Promise<void> {
  if (process.platform !== 'darwin') {
    const key = action === 'Zoom In' ? '=' : action === 'Zoom Out' ? '-' : '0'
    await page.keyboard.press(`${zoomModifier}+${key}`)
    return
  }
  // 2d6d5b18d: macOS owns these accelerators in the native View menu.
  // CDP keys do not activate that menu. Run its real click handler and focused window.
  await app.evaluate(({ Menu, BrowserWindow }, label) => {
    const view = Menu.getApplicationMenu()?.items.find((item) => item.label === 'View')
    const item = view?.submenu?.items.find((candidate) => candidate.label === label)
    const window = BrowserWindow.getFocusedWindow()
    if (!item || !window) throw new Error(`No focused window or View > ${label} item`)
    item.click(item, window, {})
  }, action)
}

test.beforeAll(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-zoom-shortcuts-'))
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_PRO: '0',
      // Native menu accelerators need a focusable window (f33b197ff, 2d6d5b18d).
      OFFGRID_E2E_HEADED: '1',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true })
})

test('desktop zoom shortcuts are complete and persist across restart', async () => {
  const mainWindow = await app.browserWindow(page)
  await mainWindow.evaluate((window) => window.focus())
  await app.evaluate(({ app: electronApp }) => electronApp.focus({ steal: true }))
  await expect.poll(() => mainWindow.evaluate((window) => window.isFocused())).toBe(true)
  const initialWidth = await visibleLayoutWidth()

  await zoom('Zoom In')
  await expect.poll(visibleLayoutWidth).toBeLessThan(initialWidth)

  await zoom('Zoom Out')
  await expect.poll(visibleLayoutWidth).toBe(initialWidth)

  await zoom('Zoom In')
  await expect.poll(visibleLayoutWidth).toBeLessThan(initialWidth)
  const zoomedWidth = await visibleLayoutWidth()
  await app.close()

  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_PRO: '0',
      // Native menu accelerators need a focusable window (f33b197ff, 2d6d5b18d).
      OFFGRID_E2E_HEADED: '1',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
  await expect.poll(visibleLayoutWidth).toBe(zoomedWidth)

  const restoredWindow = await app.browserWindow(page)
  await restoredWindow.evaluate((window) => window.focus())
  await app.evaluate(({ app: electronApp }) => electronApp.focus({ steal: true }))
  await expect.poll(() => restoredWindow.evaluate((window) => window.isFocused())).toBe(true)
  await zoom('Actual Size')
  await expect.poll(visibleLayoutWidth).toBe(initialWidth)

  await gotoSettings(page)
  await openSettingsSection(page, 'Keyboard shortcuts')
  await expect(page.getByText('Window zoom', { exact: true })).toBeVisible()
  await expect(page.getByText('+ / - / 0', { exact: true })).toBeVisible()
})
