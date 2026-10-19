/**
 * Who the gateway serves: "Just me" (one request at a time, as always) or "Team" (several clients
 * at once). Real app, real gateway. The choice is made on the Gateway screen, survives a relaunch,
 * and is what the gateway's own settings route reports.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { GATEWAY_PORT } from '../src/shared/ports'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid } from './helpers/launch'
import { enginePortsUnavailableReason } from './helpers/ports'
import { closeAndWait, gotoScreen, mainWindow } from './helpers/windows'

let app: ElectronApplication | null = null
let page: Page
let profileDir: string

/** The gateway's own view of the settings, as a script on this machine would read them. */
const gatewaySettings = (): Promise<{ gatewayMode?: string; gatewayClients?: number | null }> =>
  new Promise((resolve, reject) => {
    const request = http.get(
      { host: '127.0.0.1', port: GATEWAY_PORT, path: '/v1/settings' },
      (response) => {
        let raw = ''
        response.on('data', (chunk) => (raw += chunk))
        response.on('end', () => resolve(JSON.parse(raw) as { gatewayMode?: string }))
      }
    )
    request.on('error', reject)
  })
const gatewayMode = async (): Promise<string | undefined> => (await gatewaySettings()).gatewayMode

const launch = async (): Promise<void> => {
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profileDir,
      OFFGRID_BIN_DIR: path.join(profileDir, 'bin'),
      OFFGRID_PRO: '0',
      NODE_ENV: 'production'
    }
  })
  page = await mainWindow(app)
  await completeOnboarding(page)
  await expect.poll(() => gatewayMode().catch(() => null), { timeout: 30_000 }).not.toBeNull()
}

test.describe('Gateway mode', () => {
  test.beforeEach(async () => {
    const busy = await enginePortsUnavailableReason()
    test.skip(busy !== null, busy ?? '')
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-gateway-mode-'))
    await launch()
  })

  test.afterEach(async () => {
    if (app) await closeAndWait(app)
    app = null
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true })
  })

  test('Team mode is chosen on the Gateway screen and kept after a relaunch', async () => {
    test.setTimeout(3 * 60_000)
    await gotoScreen(page, 'Gateway')
    const clients = page.getByRole('region', { name: 'Clients' })
    await expect(clients.getByRole('radio', { name: 'Just me' })).toBeChecked()
    expect(await gatewayMode()).toBe('single')

    await clients.getByRole('radio', { name: 'Team' }).click()
    await expect(clients.getByRole('radio', { name: 'Team' })).toBeChecked()
    const requests = clients.getByRole('combobox', { name: 'Requests at once' })
    await expect(requests).toContainText(/^Auto \(\d+\)$/)
    await expect.poll(gatewayMode).toBe('team')

    // A manual "requests at once": one, the lowest any machine allows.
    await requests.click()
    await page.getByRole('option', { name: '1 at once', exact: true }).click()
    await expect(requests).toContainText('1 at once')
    await expect.poll(async () => (await gatewaySettings()).gatewayClients).toBe(1)
    await page.screenshot({ path: 'e2e/screenshots/gateway-mode.png' })

    await closeAndWait(app!)
    await launch()
    await gotoScreen(page, 'Gateway')
    const relaunched = page.getByRole('region', { name: 'Clients' })
    await expect(relaunched.getByRole('radio', { name: 'Team' })).toBeChecked()
    await expect(relaunched.getByRole('combobox', { name: 'Requests at once' })).toContainText(
      '1 at once'
    )
    expect(await gatewayMode()).toBe('team')
    expect((await gatewaySettings()).gatewayClients).toBe(1)
  })
})
