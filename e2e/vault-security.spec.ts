/**
 * Vault security while the vault is open: change the master password, and get a new recovery
 * phrase.
 *
 * Real app, real vault (KDBX4 on disk) and IPC, on a temporary profile; nothing is faked. The
 * person creates a vault through the gate, then:
 *   - makes a new recovery phrase with their master password, as someone who never saw theirs;
 *   - changes the master password, which hands over another new phrase, because the old one
 *     escrowed the old password;
 *   - locks, fails to open with the old password, opens with the new one;
 *   - forgets the password and resets it with the last phrase shown.
 */
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import { completeOnboarding } from './helpers/onboarding'
import { createVaultThroughGate } from './helpers/vault'

// All values belong to this temporary demo profile. No personal profile is opened.
const FIRST_PASSWORD = 'Demo-vault-master-2026!'
const CHANGED_PASSWORD = 'Demo-vault-changed-2026!'
const RESET_PASSWORD = 'Demo-vault-reset-2026!'
const SAVED = 'I wrote these 24 words down and keep them somewhere safe'
const SCREENSHOTS = path.resolve('e2e/screenshots')

let app: Awaited<ReturnType<typeof electron.launch>> | null = null
let page: Page
let profileDir: string | undefined

async function setTheme(mode: 'Light' | 'Dark'): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Primary navigation' })
  const selected = nav.getByRole('button', { name: `Theme: ${mode}`, exact: true })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await selected.isVisible()) break
    await nav.getByRole('button', { name: /^Theme:/ }).click()
  }
  await expect(selected).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-theme', mode.toLowerCase())
}

async function screenshot(name: string): Promise<void> {
  await page.screenshot({ path: path.join(SCREENSHOTS, name), animations: 'disabled' })
}

/** The 24 words a phrase reveal shows, in order. */
async function shownWords(): Promise<string[]> {
  const words = (
    await page.getByRole('list', { name: 'Recovery phrase' }).getByRole('listitem').allInnerTexts()
  ).map((line) => line.split(' ')[1]!)
  expect(words).toHaveLength(24)
  return words
}

async function confirmSaved(): Promise<void> {
  const done = page.getByRole('button', { name: 'Done', exact: true })
  await expect(done).toBeDisabled()
  await page.getByLabel(SAVED).check()
  await done.click()
}

async function fill(label: string, value: string): Promise<void> {
  await page.getByLabel(label, { exact: true }).fill(value)
}

test.describe('Vault security', () => {
  test.skip(targetIsPackaged(), 'This source test uses OFFGRID_PRO=1 to activate Pro.')
  test.describe.configure({ timeout: 180_000 })

  test.beforeEach(async () => {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-vault-security-'))
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
    await setTheme('Light')
    await page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('button', { name: 'Vault', exact: true })
      .click()
  })

  test.afterEach(async () => {
    const running = app
    app = null
    if (running) {
      const child = running.process()
      await running.close()
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => child.once('exit', () => resolve()))
      }
    }
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true })
  })

  test('changes the master password and makes a working recovery phrase while the vault is open', async () => {
    const firstPhrase = await createVaultThroughGate(page, FIRST_PASSWORD)

    await page.getByRole('button', { name: 'Vault security', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Vault security', exact: true })).toBeVisible()
    await screenshot('vault-security-panel.png')

    // As someone who never saw their phrase: a new one, after the master password.
    await fill('Master password', FIRST_PASSWORD)
    await page.getByRole('button', { name: 'Make a new recovery phrase', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: 'Your new recovery phrase', exact: true })
    ).toBeVisible()
    const madePhrase = await shownWords()
    expect(madePhrase).not.toEqual(firstPhrase)
    await screenshot('vault-security-new-phrase.png')
    await confirmSaved()

    // Change the password. The phrase escrowed the old one, so another new phrase comes with it.
    await fill('Current password', FIRST_PASSWORD)
    await fill('New password', CHANGED_PASSWORD)
    await fill('Confirm new password', 'Demo-vault-typo-2026!')
    await page.getByRole('button', { name: 'Change password', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('The new passwords do not match.')
    await screenshot('vault-security-password-mismatch.png')
    await fill('Confirm new password', CHANGED_PASSWORD)
    await page.getByRole('button', { name: 'Change password', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: 'Your new recovery phrase', exact: true })
    ).toBeVisible()
    await expect(
      page.getByText(/your old recovery phrase no longer opens this vault/)
    ).toBeVisible()
    const changedPhrase = await shownWords()
    await screenshot('vault-security-password-changed.png')
    await confirmSaved()

    // Lock: the old password is refused, the new one opens.
    await page.getByRole('button', { name: 'Lock vault', exact: true }).click()
    await fill('Master password', FIRST_PASSWORD)
    await page.getByRole('button', { name: 'Open Vault', exact: true }).click()
    await expect(page.getByRole('alert')).toBeVisible()
    await fill('Master password', CHANGED_PASSWORD)
    await page.getByRole('button', { name: 'Open Vault', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Lock vault', exact: true })).toBeVisible()

    // Forgot the password: the last phrase shown resets it and opens the vault.
    await page.getByRole('button', { name: 'Lock vault', exact: true }).click()
    await page.getByRole('button', { name: /Forgot password/ }).click()
    await fill('Recovery phrase', changedPhrase.join(' '))
    await fill('Master password', RESET_PASSWORD)
    await fill('Confirm password', RESET_PASSWORD)
    await page.getByRole('button', { name: 'Reset password and open vault', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Lock vault', exact: true })).toBeVisible()
  })
})
