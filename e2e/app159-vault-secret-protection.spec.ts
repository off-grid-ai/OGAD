/**
 * APP-159 — vault secrets stay protected through reveal, copy, lock and unlock.
 *
 * Every entry is created through the rendered Vault UI. The production KDBX
 * service, device-bound crypto, persistence, preload and IPC remain real, as
 * does Electron's OS clipboard. Direct IPC probes after locking are supplemental
 * security assertions: they prove a compromised renderer cannot read or add an
 * entry after the visible vault has closed.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'

const PRO_PRESENT = fs.existsSync(path.resolve('pro/package.json'))
const MASTER_PASSWORD = 'vault-master-APP159'

const LOGIN = {
  title: 'Production Console',
  username: 'login-user@offgrid.test',
  password: 'LOGIN-SECRET-9f47',
  url: 'https://console.offgrid.test'
}

const API_KEY = {
  title: 'Payments Production Key',
  username: 'production-payments',
  password: 'KEY-TOKEN-f81c'
}

const SECURE_NOTE = {
  title: 'Incident Recovery Note',
  secret: 'NOTE-SECRET-a27d: use the break-glass channel'
}

let app: ElectronApplication | null = null
let page: Page
let profileDir: string

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
}

async function closeApp(): Promise<void> {
  const running = app
  if (!running) return
  app = null
  const child = running.process()
  await running.close()
  await waitForExit(child)
}

async function launchProfile(): Promise<void> {
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profileDir,
      OFFGRID_PRO: '1',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)
  const expand = page.getByRole('button', { name: 'Expand sidebar' })
  if (await expand.isVisible().catch(() => false)) await expand.click()
  await openVault()
}

async function openVault(): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Primary navigation' })
  const vault = nav.getByRole('button', { name: 'Vault', exact: true })
  await expect(vault).toBeVisible()
  await vault.click()
  await expect(
    page
      .getByText('Off Grid Vault', { exact: true })
      .or(page.getByRole('button', { name: 'Lock vault', exact: true }))
  ).toBeVisible()
}

async function setTheme(mode: 'Light' | 'Dark'): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Primary navigation' })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await nav.getByRole('button', { name: `Theme: ${mode}`, exact: true }).isVisible()) return
    await nav.getByRole('button', { name: /^Theme:/ }).click()
  }
  await expect(nav.getByRole('button', { name: `Theme: ${mode}`, exact: true })).toBeVisible()
}

async function createVault(): Promise<void> {
  await page.getByPlaceholder('Master password').fill(MASTER_PASSWORD)
  await page.getByPlaceholder('Confirm password').fill(MASTER_PASSWORD)
  await page.getByRole('button', { name: 'Create Vault', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Save your recovery phrase' })).toBeVisible()
  await page.getByRole('button', { name: "I've saved it — open vault" }).click()
  await expect(page.getByRole('button', { name: 'Lock vault', exact: true })).toBeVisible()
}

async function beginEntry(type: 'Web Login' | 'API Key' | 'Secure Note'): Promise<void> {
  await page.getByTitle('New entry').click()
  await expect(page.getByText('New Entry', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: type, exact: true }).click()
}

async function addLogin(): Promise<void> {
  await beginEntry('Web Login')
  await page.getByPlaceholder('e.g. Web Login').fill(LOGIN.title)
  await page.getByPlaceholder('you@example.com').fill(LOGIN.username)
  await page.getByPlaceholder('••••••••').fill(LOGIN.password)
  await page.getByPlaceholder('https://').fill(LOGIN.url)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('heading', { name: LOGIN.title, exact: true })).toBeVisible()
}

async function addApiKey(): Promise<void> {
  await beginEntry('API Key')
  await page.getByPlaceholder('e.g. API Key').fill(API_KEY.title)
  await page.getByPlaceholder('e.g. production').fill(API_KEY.username)
  await page.getByPlaceholder('••••••••').fill(API_KEY.password)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('heading', { name: API_KEY.title, exact: true })).toBeVisible()
}

async function addSecureNote(): Promise<void> {
  await beginEntry('Secure Note')
  await page.getByPlaceholder('e.g. Secure Note').fill(SECURE_NOTE.title)
  await page.getByPlaceholder('Additional details...').fill(SECURE_NOTE.secret)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('heading', { name: SECURE_NOTE.title, exact: true })).toBeVisible()
}

async function selectEntry(title: string): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`^${title}`) }).click()
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
}

function detailRow(label: string): ReturnType<Page['locator']> {
  return page.getByText(label, { exact: true }).locator('..')
}

async function expectClipboard(expected: string): Promise<void> {
  if (!app) throw new Error('Electron app is not running')
  await expect
    .poll(() => app!.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 3_000 })
    .toBe(expected)
}

async function unlock(): Promise<void> {
  await page.getByPlaceholder('Master password').fill(MASTER_PASSWORD)
  await page.getByRole('button', { name: 'Unlock', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Lock vault', exact: true })).toBeVisible()
}

test.describe('APP-159 vault secret protection', () => {
  test.skip(!PRO_PRESENT, 'Pro package is required for the real Vault surface.')
  test.skip(
    targetIsPackaged(),
    'Source E2E uses forced Pro activation; packaged proof needs a license.'
  )
  test.describe.configure({ timeout: 120_000 })

  test.beforeEach(async () => {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-app159-'))
    await launchProfile()
    await createVault()
  })

  test.afterEach(async () => {
    if (app) {
      await app.evaluate(({ clipboard }) => clipboard.clear()).catch(() => {})
    }
    await closeApp()
    if (path.basename(profileDir).startsWith('offgrid-app159-')) {
      fs.rmSync(profileDir, { recursive: true, force: true })
    }
  })

  // Playwright requires the first callback argument to use object destructuring.
  // eslint-disable-next-line no-empty-pattern
  test('masks login and API secrets, copies exact fields, then locks and restores safely', async ({}, testInfo) => {
    await addLogin()
    await addApiKey()

    const vaultPath = path.join(profileDir, 'vault.kdbx')
    const encrypted = fs.readFileSync(vaultPath)
    expect(encrypted.byteLength).toBeGreaterThan(1_000)
    expect(encrypted.includes(Buffer.from(LOGIN.password))).toBe(false)
    expect(encrypted.includes(Buffer.from(API_KEY.password))).toBe(false)

    await selectEntry(LOGIN.title)
    const loginPassword = detailRow('Password')
    await expect(loginPassword.getByText('••••••••••••', { exact: true })).toBeVisible()
    await expect(page.getByText(LOGIN.password, { exact: true })).toHaveCount(0)
    await setTheme('Light')
    await page.screenshot({
      path: testInfo.outputPath('app159-light-masked-login.png'),
      fullPage: true
    })

    const username = detailRow('Username / Email')
    await username.getByRole('button', { name: 'Copy', exact: true }).click()
    await expectClipboard(LOGIN.username)

    await loginPassword.getByTitle('Reveal').click()
    await expect(loginPassword.getByText(LOGIN.password, { exact: true })).toBeVisible()
    await expect(page.getByText(API_KEY.password, { exact: true })).toHaveCount(0)
    await loginPassword.getByRole('button', { name: 'Copy', exact: true }).click()
    await expectClipboard(LOGIN.password)
    await loginPassword.getByTitle('Hide').click()
    await expect(page.getByText(LOGIN.password, { exact: true })).toHaveCount(0)

    const website = detailRow('Website')
    await website.getByRole('button', { name: 'Copy', exact: true }).click()
    await expectClipboard(LOGIN.url)

    await selectEntry(API_KEY.title)
    const keyToken = detailRow('Key / Token')
    await expect(keyToken.getByText('••••••••••••', { exact: true })).toBeVisible()
    await keyToken.getByTitle('Reveal').click()
    await expect(keyToken.getByText(API_KEY.password, { exact: true })).toBeVisible()
    await expect(page.getByText(LOGIN.password, { exact: true })).toHaveCount(0)
    await keyToken.getByRole('button', { name: 'Copy', exact: true }).click()
    await expectClipboard(API_KEY.password)

    await page.getByRole('button', { name: 'Lock vault', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Unlock Vault' })).toBeVisible()
    await expect(page.getByText(LOGIN.password, { exact: true })).toHaveCount(0)
    await expect(page.getByText(API_KEY.password, { exact: true })).toHaveCount(0)

    const denied = await page.evaluate(async () => {
      const api = (
        window as unknown as {
          api: { proInvoke: (channel: string, ...args: unknown[]) => Promise<unknown> }
        }
      ).api
      const list = (await api.proInvoke('vault:entries:list')) as {
        ok: boolean
        error?: string
        entries: unknown[]
      }
      const add = (await api.proInvoke('vault:entries:add', {
        title: 'Blocked while locked',
        password: 'must-not-persist',
        type: 'login'
      })) as { ok: boolean; error?: string }
      return { list, add }
    })
    expect(denied.list).toMatchObject({ ok: false, entries: [] })
    expect(denied.list.error).toMatch(/locked/i)
    expect(denied.add.ok).toBe(false)
    expect(denied.add.error).toMatch(/locked/i)

    await unlock()
    await expect(page.getByText('Blocked while locked', { exact: true })).toHaveCount(0)
    await selectEntry(LOGIN.title)
    await expect(detailRow('Password').getByText('••••••••••••', { exact: true })).toBeVisible()
    await expect(page.getByText(LOGIN.password, { exact: true })).toHaveCount(0)
    await expect(page.getByText(API_KEY.password, { exact: true })).toHaveCount(0)
    await setTheme('Dark')
    await page.screenshot({
      path: testInfo.outputPath('app159-dark-masked-after-unlock.png'),
      fullPage: true
    })
  })

  // Playwright requires the first callback argument to use object destructuring.
  // eslint-disable-next-line no-empty-pattern
  test('masks a secure note until an explicit reveal', async ({}, testInfo) => {
    await addSecureNote()
    const encrypted = fs.readFileSync(path.join(profileDir, 'vault.kdbx'))
    expect(encrypted.includes(Buffer.from(SECURE_NOTE.secret))).toBe(false)

    const listProjection = await page.evaluate(async () => {
      const api = (
        window as unknown as {
          api: { proInvoke: (channel: string, ...args: unknown[]) => Promise<unknown> }
        }
      ).api
      return api.proInvoke('vault:entries:list') as Promise<{
        ok: boolean
        entries: Array<{ uuid: string; title: string; notes: string }>
      }>
    })
    expect(listProjection.ok).toBe(true)
    const noteProjection = listProjection.entries.find(({ title }) => title === SECURE_NOTE.title)
    expect(noteProjection).toBeDefined()
    expect(noteProjection!.notes).toBe('')
    expect(JSON.stringify(listProjection)).not.toContain(SECURE_NOTE.secret)

    await expect(page.getByText(SECURE_NOTE.secret, { exact: true })).toHaveCount(0)
    await setTheme('Light')
    await page.screenshot({
      path: testInfo.outputPath('app159-light-secure-note-masked.png'),
      fullPage: true
    })

    const noteRow = detailRow('Notes')
    await expect(noteRow.getByText('••••••••••••', { exact: true })).toBeVisible()
    await expect(noteRow.getByTitle('Reveal')).toBeVisible()
    await noteRow.getByTitle('Reveal').click()
    await expect(noteRow.getByText(SECURE_NOTE.secret, { exact: true })).toBeVisible()
    await noteRow.getByRole('button', { name: 'Copy', exact: true }).click()
    await expectClipboard(SECURE_NOTE.secret)

    await noteRow.getByTitle('Hide').click()
    await expect(page.getByText(SECURE_NOTE.secret, { exact: true })).toHaveCount(0)

    await noteRow.getByTitle('Reveal').click()
    await expect(noteRow.getByText(SECURE_NOTE.secret, { exact: true })).toBeVisible()
    const nav = page.getByRole('navigation', { name: 'Primary navigation' })
    await nav.getByRole('button', { name: 'Chat', exact: true }).click()
    await expect(page.getByText(SECURE_NOTE.secret, { exact: true })).toHaveCount(0)
    await openVault()
    await selectEntry(SECURE_NOTE.title)
    await expect(page.getByText(SECURE_NOTE.secret, { exact: true })).toHaveCount(0)
    await expect(detailRow('Notes').getByTitle('Reveal')).toBeVisible()

    await detailRow('Notes').getByTitle('Reveal').click()
    await expect(page.getByText(SECURE_NOTE.secret, { exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Lock vault', exact: true }).click()
    await expect(page.getByText(SECURE_NOTE.secret, { exact: true })).toHaveCount(0)

    const deniedGet = await page.evaluate(async (uuid) => {
      const api = (
        window as unknown as {
          api: { proInvoke: (channel: string, ...args: unknown[]) => Promise<unknown> }
        }
      ).api
      return api.proInvoke('vault:entries:get', uuid)
    }, noteProjection!.uuid)
    expect(deniedGet).toMatchObject({ ok: false })

    await unlock()
    await selectEntry(SECURE_NOTE.title)
    await expect(page.getByText(SECURE_NOTE.secret, { exact: true })).toHaveCount(0)
    await expect(detailRow('Notes').getByTitle('Reveal')).toBeVisible()

    await detailRow('Notes').getByTitle('Reveal').click()
    await expect(page.getByText(SECURE_NOTE.secret, { exact: true })).toBeVisible()
    await closeApp()
    await launchProfile()
    await expect(page.getByRole('heading', { name: 'Unlock Vault' })).toBeVisible()
    await expect(page.getByText(SECURE_NOTE.secret, { exact: true })).toHaveCount(0)
    await unlock()
    await selectEntry(SECURE_NOTE.title)
    await expect(page.getByText(SECURE_NOTE.secret, { exact: true })).toHaveCount(0)
    await expect(detailRow('Notes').getByTitle('Reveal')).toBeVisible()
    await setTheme('Dark')
    await page.screenshot({
      path: testInfo.outputPath('app159-dark-secure-note-masked-after-relaunch.png'),
      fullPage: true
    })
  })
})
