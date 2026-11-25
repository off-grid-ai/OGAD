import { _electron as electron, expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import { completeOnboarding } from './helpers/onboarding'
import { createVaultThroughGate } from './helpers/vault'

// All values belong to this temporary demo profile. No personal profile is opened.
const MASTER_PASSWORD = 'Demo-vault-master-2026!'
const SHOTS = process.env.OFFGRID_E2E_SHOTS ?? path.resolve('e2e/screenshots')

let app: Awaited<ReturnType<typeof electron.launch>> | null = null
let page: Page
let profileDir: string | undefined

const generated = (scope: Page): ReturnType<Page['getByRole']> =>
  scope.getByRole('status', { name: 'Generated password', exact: true })

test.describe('Vault password generator', () => {
  test.skip(!fs.existsSync(path.resolve('pro/package.json')), 'Pro is required for the Vault.')
  test.skip(targetIsPackaged(), 'This source test uses OFFGRID_PRO=1 to activate Pro.')
  test.setTimeout(180_000)

  test.beforeEach(async () => {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-vault-generator-'))
    fs.mkdirSync(SHOTS, { recursive: true })
    app = await launchOffGrid({
      env: {
        ...process.env,
        OFFGRID_USER_DATA: profileDir,
        OFFGRID_PRO: '1',
        OFFGRID_SEED: '',
        OFFGRID_SEED_PRO: '',
        NODE_ENV: 'production'
      }
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(1280, 900)
    })
    await completeOnboarding(page)
    const expand = page.getByRole('button', { name: 'Expand sidebar', exact: true })
    if (await expand.isVisible()) await expand.click()
    await page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('button', { name: 'Vault', exact: true })
      .click()
    await createVaultThroughGate(page, MASTER_PASSWORD)
  })

  test.afterEach(async () => {
    const running = app
    app = null
    try {
      if (running) {
        const child = running.process()
        await running.close()
        if (child.exitCode === null && child.signalCode === null) {
          await new Promise<void>((resolve) => child.once('exit', () => resolve()))
        }
      }
    } finally {
      if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true })
      profileDir = undefined
    }
  })

  test('makes, tunes, remembers and uses a password from the header and the entry form', async () => {
    // Standalone, from the Vault header: a 20-character password with its strength.
    await page.getByRole('button', { name: 'Generate password', exact: true }).first().click()
    await expect(page.getByText('Password generator', { exact: true })).toBeVisible()
    const output = generated(page)
    await expect(output).toHaveText(/^.{20}$/)
    await expect(page.getByText('Very strong', { exact: true })).toBeVisible()

    // Length and character classes change the value live.
    const length = page.getByRole('spinbutton', { name: 'Length', exact: true })
    await length.fill('32')
    await expect(output).toHaveText(/^.{32}$/)
    await page.getByRole('switch', { name: 'Symbols (!@#$)', exact: true }).click()
    await expect(output).toHaveText(/^[A-Za-z0-9]{32}$/)

    // The last class left on cannot be turned off.
    await page.getByRole('switch', { name: 'Uppercase (A-Z)', exact: true }).click()
    await page.getByRole('switch', { name: 'Lowercase (a-z)', exact: true }).click()
    await expect(page.getByRole('switch', { name: 'Numbers (0-9)', exact: true })).toBeDisabled()
    await expect(output).toHaveText(/^[0-9]{32}$/)
    await page.getByRole('switch', { name: 'Uppercase (A-Z)', exact: true }).click()
    await page.getByRole('switch', { name: 'Lowercase (a-z)', exact: true }).click()

    // Regenerate gives a new value.
    const before = await output.innerText()
    await page.getByRole('button', { name: 'Generate another', exact: true }).click()
    await expect(output).not.toHaveText(before)

    // Passphrase mode.
    await page.getByRole('radio', { name: 'Passphrase', exact: true }).click()
    await expect(output).toHaveText(/^([A-Za-z]+\d?-){4}[A-Za-z]+\d?$/)
    await page.screenshot({ path: path.join(SHOTS, 'vault-generator-passphrase.png') })
    await page.getByRole('radio', { name: 'Random', exact: true }).click()
    await expect(output).toHaveText(/^[A-Za-z0-9]{32}$/)
    await page.screenshot({ path: path.join(SHOTS, 'vault-generator-panel.png') })

    // Save as new login carries the value into a new entry's password.
    const value = await output.innerText()
    await page.getByRole('button', { name: 'Save as new login', exact: true }).click()
    await expect(page.getByText('New Entry', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue(value)

    // In the form: the generator opens beside the password and keeps the remembered settings.
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Demo forum (demo)')
    await page.getByLabel('Password', { exact: true }).fill('')
    await page
      .locator('form')
      .getByRole('button', { name: 'Generate password', exact: true })
      .click()
    const inline = generated(page)
    await expect(inline).toHaveText(/^[A-Za-z0-9]{32}$/)
    await page.screenshot({ path: path.join(SHOTS, 'vault-generator-form.png') })
    const fresh = await inline.innerText()
    await page.getByRole('button', { name: 'Use this password', exact: true }).click()
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue(fresh)
    await expect(inline).toHaveCount(0)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: 'Demo forum (demo)', exact: true })
    ).toBeVisible()
  })
})
