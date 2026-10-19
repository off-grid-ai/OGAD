/**
 * Who the local gateway answers.
 *
 * Real app, real gateway on its fixed port. The test is the API client: it calls the gateway the
 * way a phone, a script or a web page would.
 *
 * 1. A key made on the Gateway screen opens the API until it expires, and stays listed after a
 *    relaunch.
 * 2. A web page's origin can use the inference routes, as in 0.0.54, but not the routes that
 *    reach tools or change settings. A browser extension's origin is treated the same way. The
 *    app's own origin gets its value echoed back.
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

const KEY_NAME = 'E2E laptop'

let app: ElectronApplication | null = null
let page: Page
let profileDir: string

interface GatewayReply {
  status: number
  allowOrigin: string | undefined
}

/** One request to the gateway, with headers a browser would refuse to let a page set. */
const call = (
  method: string,
  route: string,
  headers: Record<string, string> = {},
  body?: string
): Promise<GatewayReply> =>
  new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: GATEWAY_PORT,
        method,
        path: route,
        headers: body ? { 'content-type': 'application/json', ...headers } : headers
      },
      (response) => {
        response.resume()
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            allowOrigin: response.headers['access-control-allow-origin'] as string | undefined
          })
        )
      }
    )
    request.on('error', reject)
    request.end(body)
  })

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
  await expect
    .poll(async () => (await call('GET', '/health').catch(() => null))?.status, {
      timeout: 30_000
    })
    .toBe(200)
}

/** A datetime-local value, in local time, at least `ms` from now on a whole minute. */
const localMinute = (ms: number): { value: string; at: number } => {
  const at = new Date(Date.now() + ms)
  at.setSeconds(0, 0)
  at.setMinutes(at.getMinutes() + 1)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return {
    value: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`,
    at: at.getTime()
  }
}

test.describe('Gateway access', () => {
  test.beforeEach(async () => {
    const busy = await enginePortsUnavailableReason()
    test.skip(busy !== null, busy ?? '')
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-gateway-access-'))
    await launch()
  })

  test.afterEach(async () => {
    if (app) await closeAndWait(app)
    app = null
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true })
  })

  test('A gateway key works until it expires and stays listed after a relaunch', async () => {
    test.setTimeout(5 * 60_000)
    await gotoScreen(page, 'Gateway')
    const keys = page.getByRole('region', { name: 'API keys' })
    // One switch is the setting and its state; its status line says it in words.
    await expect(keys.getByRole('switch', { name: 'Require an API key' })).not.toBeChecked()
    await expect(keys.getByRole('status').filter({ hasText: 'API key' })).toContainText(
      'API key not required'
    )

    await keys.getByLabel('Key name').fill(KEY_NAME)
    await keys.getByRole('combobox', { name: 'Expiry' }).click()
    await page.getByRole('option', { name: 'Custom date and time', exact: true }).click()
    // The earliest whole minute that leaves time to check the key before it lapses.
    const expiry = localMinute(60_000)
    await keys.getByLabel('Expires at (local time)').fill(expiry.value)
    await keys.getByRole('button', { name: 'Create key', exact: true }).click()

    const shown = keys.getByLabel('Copy this key now. It will not be shown again.')
    await expect(shown).toHaveValue(/^ogad_[a-f0-9]{64}$/)
    const key = await shown.inputValue()
    await keys.getByRole('button', { name: 'Copy key', exact: true }).click()
    await expect(keys.getByText('Key copied.')).toBeVisible()
    expect(await app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(key)
    await expect(keys.getByRole('switch', { name: 'Require an API key' })).toBeChecked()
    await expect(keys.getByRole('status').filter({ hasText: 'API key' })).toContainText(
      'API key required'
    )
    await expect(keys.getByText(`${KEY_NAME} · Active`)).toBeVisible()

    const bearer = { authorization: `Bearer ${key}` }
    expect((await call('GET', '/v1/models', bearer)).status).toBe(200)
    expect((await call('GET', '/v1/models')).status).toBe(401)
    expect((await call('GET', '/v1/models', { authorization: 'Bearer ogad_wrong' })).status).toBe(
      401
    )

    // The key and the rule outlive the process.
    await closeAndWait(app!)
    await launch()
    await gotoScreen(page, 'Gateway')
    const relaunched = page.getByRole('region', { name: 'API keys' })
    await expect(relaunched.getByText(`${KEY_NAME} · Active`)).toBeVisible()
    await expect(relaunched.getByText(key)).toHaveCount(0)
    expect((await call('GET', '/v1/models', bearer)).status).toBe(200)
    expect((await call('GET', '/v1/models')).status).toBe(401)

    // Once the expiry passes, the same key is refused and the list says why.
    await page.waitForTimeout(Math.max(0, expiry.at - Date.now()) + 1_000)
    expect((await call('GET', '/v1/models', bearer)).status).toBe(401)
    await relaunched.getByRole('button', { name: 'Refresh status', exact: true }).click()
    await expect(relaunched.getByText(`${KEY_NAME} · Expired`)).toBeVisible()
  })

  test('The gateway answers web pages and extensions by origin', async () => {
    const settingsWrite = JSON.stringify({ residency: {} })
    const website = { origin: 'https://evil.example' }
    const extension = { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' }
    const app = { origin: `http://127.0.0.1:${GATEWAY_PORT}` }

    // A web page: inference stays open with the 0.0.54 wildcard, tools and settings do not.
    const websiteModels = await call('GET', '/v1/models', website)
    expect(websiteModels.status).toBe(200)
    expect(websiteModels.allowOrigin).toBe('*')
    expect((await call('POST', '/v1/settings', website, settingsWrite)).status).toBe(403)
    expect((await call('POST', '/mcp', website, '{}')).status).toBe(403)
    expect(
      (
        await call('OPTIONS', '/v1/settings', {
          ...website,
          'access-control-request-method': 'POST'
        })
      ).status
    ).toBe(403)

    // A browser extension's own origin gets no more than a web page.
    expect((await call('POST', '/v1/settings', extension, settingsWrite)).status).toBe(403)
    expect((await call('POST', '/mcp', extension, '{}')).status).toBe(403)
    expect((await call('GET', '/v1/models', extension)).allowOrigin).toBe('*')

    // The app's own origin is trusted, and gets its own value back rather than the wildcard.
    const trusted = await call('GET', '/v1/models', app)
    expect(trusted.status).toBe(200)
    expect(trusted.allowOrigin).toBe(app.origin)
    expect((await call('POST', '/mcp', app, '{}')).status).not.toBe(403)
  })
})
