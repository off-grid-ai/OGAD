/**
 * A browser pairs with Desktop, connects, and is revoked.
 *
 * Real app and real bridge; the only boundaries are the fake paired browser (the extension's side
 * of the protocol) and the native pairing dialog, which the spec answers the way a person does:
 * Pair only when Desktop shows the same words as the browser.
 *
 * Asserts: the dialog names the browser and shows its words; once paired and connected, Web Use
 * can run in the default browser and says it is connected; a browser showing other words is
 * refused; after the browser unpairs, its socket closes, it cannot reconnect or call Desktop, and
 * Web Use no longer offers it.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import { enginePortsUnavailableReason } from './helpers/ports'
import {
  answerPairingDialog,
  FakeExtension,
  pairedBrowser,
  pairingDialogs
} from './helpers/fake-extension'
import { closeAndWait, mainWindow } from './helpers/windows'

const PRO_PRESENT = fs.existsSync(path.resolve('pro/package.json'))

let app: ElectronApplication | null = null
let page: Page
let profileDir: string
let browser: FakeExtension | null = null

const openTaskSettings = async (): Promise<void> => {
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  await page.getByRole('button', { name: 'Active models', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).last().click()
  await page.getByRole('radio', { name: 'tasks', exact: true }).click()
}

test.describe('Browser pairing', () => {
  test.skip(targetIsPackaged(), 'The pairing dialog boundary is for the source-built E2E target.')

  test.beforeEach(async () => {
    test.skip(!PRO_PRESENT, 'pro package not present: browser pairing is a Pro surface')
    const busy = await enginePortsUnavailableReason()
    test.skip(busy !== null, busy ?? '')
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-browser-pairing-'))
    app = await launchOffGrid({
      env: {
        ...process.env,
        OFFGRID_USER_DATA: profileDir,
        OFFGRID_BIN_DIR: path.join(profileDir, 'bin'),
        OFFGRID_PRO: '1',
        NODE_ENV: 'production',
        NO_PROXY: '127.0.0.1,localhost'
      }
    })
    page = await mainWindow(app)
    await completeOnboarding(page)
  })

  test.afterEach(async () => {
    await browser?.close()
    browser = null
    if (app) await closeAndWait(app)
    app = null
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true })
  })

  test('A browser pairs with matching words, connects, and is revoked', async () => {
    test.setTimeout(120_000)
    browser = new FakeExtension('E2E Browser')
    const code = await browser.pairingCode()
    await answerPairingDialog(app!, code)
    expect(await browser.pair()).toEqual({ status: 200 })
    const [dialog] = await pairingDialogs(app!)
    expect(dialog).toContain('Pair "E2E Browser" with Off Grid AI Desktop?')
    expect(dialog).toContain(code)
    expect((await browser.rpc('state')).status).toBe(200)
    expect(await browser.connect()).toBe(true)

    // Desktop offers the paired browser for Web Use and says it is connected.
    await openTaskSettings()
    const target = page.getByRole('combobox', { name: 'Web Use browser' })
    await target.click()
    await page.getByRole('option', { name: 'Default browser', exact: true }).click()
    await expect(
      page.getByText('Connected: E2E Browser. Tasks run in your browser', { exact: false })
    ).toBeVisible({ timeout: 15_000 })

    // A browser that shows other words is refused.
    const stranger = new FakeExtension('Stranger Browser')
    expect(await stranger.pair()).toEqual({ status: 403, error: 'declined' })

    // The browser unpairs: its live socket closes and it cannot come back.
    const closed = browser.closed()
    expect((await browser.rpc('unpair')).ok).toBe(true)
    await closed
    expect(browser.connected).toBe(false)
    expect(await browser.connect()).toBe(false)
    expect((await browser.rpc('state')).status).toBe(401)
    await expect(page.getByText('No browser is paired', { exact: false })).toBeVisible({
      timeout: 15_000
    })
  })

  test('Desktop removes a paired browser, which then cannot reconnect', async () => {
    test.setTimeout(120_000)
    browser = await pairedBrowser(app!)
    await openTaskSettings()
    const list = page.getByRole('list', { name: 'Paired browsers' })
    await expect(list.getByRole('listitem').filter({ hasText: 'E2E Browser' })).toContainText(
      'Connected'
    )

    const closed = browser.closed()
    await list.getByRole('button', { name: 'Remove E2E Browser', exact: true }).click()
    const confirm = list.getByRole('group', { name: 'Remove E2E Browser?' })
    await expect(confirm).toContainText('Pair it again from the extension')
    await confirm.getByRole('button', { name: 'Remove', exact: true }).click()

    // Its live connection closes at once, and its key no longer opens Desktop.
    await closed
    expect(browser.connected).toBe(false)
    expect(await browser.connect()).toBe(false)
    expect((await browser.rpc('state')).status).toBe(401)
    await expect(page.getByRole('list', { name: 'Paired browsers' })).toHaveCount(0)
    await expect(
      page.getByText('To use your own browser, install the Off Grid AI extension', { exact: false })
    ).toBeVisible()
  })
})
