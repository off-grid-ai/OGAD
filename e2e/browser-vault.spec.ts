/**
 * A paired browser gets a password only for a matching https site, and only while the vault is
 * unlocked.
 *
 * Real app, real vault and bridge; the boundaries are the fake paired browser and the native
 * pairing dialog. The person creates a vault and a google.com login on Desktop. The browser then
 * asks for it the way the extension's autofill does.
 *
 * Asserts: https://accounts.google.com is offered the login and gets its password; the same host
 * over http, and another site, get nothing; bulk CSV export is refused to the browser; once the
 * vault is locked on Desktop, the browser's request is refused.
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
const MASTER_PASSWORD = 'Browser-vault-demo-2026!'
const LOGIN = {
  title: 'Google (demo)',
  username: 'sam@offgrid.test',
  password: 'Demo-google-only-91!',
  url: 'https://google.com'
}

let app: ElectronApplication | null = null
let page: Page
let profileDir: string
let browser: FakeExtension | null = null

interface VaultReply {
  type: string
  reason?: string
  entries?: { uuid: string; title: string; username: string }[]
  password?: string
}

/** One vault request, as the extension sends it. */
const vault = async (request: Record<string, unknown>): Promise<VaultReply> => {
  const reply = await browser!.rpc('vault', { request: { id: randomUUID(), ...request } })
  expect(reply.ok, JSON.stringify(reply)).toBe(true)
  return reply.result as VaultReply
}

test.describe('Paired-browser vault', () => {
  test.skip(targetIsPackaged(), 'The pairing dialog boundary is for the source-built E2E target.')

  test.beforeEach(async () => {
    test.skip(!PRO_PRESENT, 'pro package not present: the vault is a Pro surface')
    const busy = await enginePortsUnavailableReason()
    test.skip(busy !== null, busy ?? '')
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-browser-vault-'))
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

  test('A browser gets the password only for the matching https host while unlocked', async () => {
    test.setTimeout(120_000)
    // The person sets up the vault and a login on Desktop.
    await gotoScreen(page, 'Vault')
    await page.getByLabel('Master password', { exact: true }).fill(MASTER_PASSWORD)
    await page.getByLabel('Confirm password', { exact: true }).fill(MASTER_PASSWORD)
    await page.getByRole('button', { name: 'Create Vault', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Lock vault', exact: true })).toBeVisible()
    await page.getByTitle('New entry', { exact: true }).click()
    await page
      .getByRole('radiogroup', { name: 'Kind', exact: true })
      .getByRole('radio', { name: 'Login', exact: true })
      .click()
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill(LOGIN.title)
    await page.getByRole('textbox', { name: 'Username / Email', exact: true }).fill(LOGIN.username)
    await page.getByLabel('Password', { exact: true }).fill(LOGIN.password)
    await page.getByRole('textbox', { name: 'Primary URL', exact: true }).fill(LOGIN.url)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('heading', { name: LOGIN.title, exact: true })).toBeVisible()

    browser = await pairedBrowser(app!)
    const secure = 'https://accounts.google.com'

    // The matching https sign-in page is offered the login and gets its password.
    const offered = await vault({ type: 'match', origin: secure })
    expect(offered.type).toBe('matches')
    expect(offered.entries?.map((entry) => entry.username)).toEqual([LOGIN.username])
    const uuid = offered.entries![0]!.uuid
    expect(await vault({ type: 'reveal', uuid, origin: secure })).toMatchObject({
      type: 'credential',
      username: LOGIN.username,
      password: LOGIN.password
    })

    // The same host over http, and another site, get no password.
    const insecure = await vault({ type: 'reveal', uuid, origin: 'http://accounts.google.com' })
    expect(insecure).toEqual(expect.objectContaining({ type: 'denied', reason: 'origin_mismatch' }))
    expect(insecure.password).toBeUndefined()
    expect((await vault({ type: 'match', origin: 'http://accounts.google.com' })).entries).toEqual(
      []
    )
    expect(
      await vault({ type: 'reveal', uuid, origin: 'https://accounts.google.com.evil.example' })
    ).toEqual(expect.objectContaining({ type: 'denied', reason: 'origin_mismatch' }))

    // A bulk export never leaves through the browser.
    expect(await vault({ type: 'exportCsv' })).toEqual(
      expect.objectContaining({ type: 'denied', reason: 'export_in_desktop' })
    )

    // Locked on Desktop, the vault answers the browser with nothing.
    await page.getByRole('button', { name: 'Lock vault', exact: true }).click()
    await expect(page.getByLabel('Master password', { exact: true })).toBeVisible()
    const locked = await vault({ type: 'reveal', uuid, origin: secure })
    expect(locked).toEqual(expect.objectContaining({ type: 'denied', reason: 'locked' }))
    expect(locked.password).toBeUndefined()
  })
})
