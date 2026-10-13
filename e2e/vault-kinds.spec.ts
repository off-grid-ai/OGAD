import { _electron as electron, expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import { completeOnboarding } from './helpers/onboarding'

// All values belong to this temporary demo profile. No personal profile is opened.
const MASTER_PASSWORD = 'Demo-vault-master-2026!'
const LOGIN = {
  title: 'Demo shop (demo)',
  username: 'demo@offgrid.test',
  password: 'Demo-shop-password-42!',
  urls: ['https://shop.example.test', 'https://checkout.example.test'],
  totp: 'JBSWY3DPEHPK3PXP'
}
const CARD = {
  title: 'Test Visa (demo)',
  holder: 'Sam Demo',
  number: '4111 1111 1111 1111',
  expiry: '12/30',
  cvv: '123'
}
const ADDRESS_TITLE = 'Sam Demo (demo)'
const ADDRESS_FIELDS = [
  ['Full name', 'Sam Demo'],
  ['Email', 'sam@offgrid.test'],
  ['Phone', '+1 202 555 0142'],
  ['Address line 1', '1 Demo Street'],
  ['Address line 2', 'Unit 2'],
  ['City', 'Testville'],
  ['Region', 'CA'],
  ['Postal code', '94000'],
  ['Country', 'United States'],
  ['Company', 'Demo Company']
] as const
const NOTE = {
  title: 'Cabin Wi-Fi (demo)',
  body: 'Demo cabin network: DemoGuest\nDemo password: Cabin-demo-only-42!'
}
const TITLES = [LOGIN.title, CARD.title, ADDRESS_TITLE, NOTE.title]
const SCREENSHOTS = path.resolve('e2e/screenshots')

let app: Awaited<ReturnType<typeof electron.launch>> | null = null
let page: Page
let profileDir: string | undefined

function entryRow(title: string): Locator {
  return entryRows().filter({ has: page.getByText(title, { exact: true }) })
}

function entryRows(): Locator {
  // VaultScreen.tsx:222-258: the row container follows the search/new toolbar.
  return page
    .getByRole('textbox', { name: 'Search vault', exact: true })
    .locator('xpath=../..')
    .locator('xpath=following-sibling::div[1]')
    .getByRole('button')
}

function detailRow(label: string): Locator {
  // DetailRow labels have a div parent; category labels have a button parent.
  return page.getByText(label, { exact: true }).locator('xpath=parent::div')
}

async function openVault(): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name: 'Vault', exact: true })
    .click()
}

async function showList(): Promise<void> {
  // VaultScreen.tsx:491-528: desktop keeps both panes; below md, use Back to items.
  const back = page.getByRole('button', { name: 'Back to items', exact: true })
  if (await back.isVisible()) await back.click()
  // All Items only changes category (VaultScreen.tsx:483-485); other filters persist.
  await page.getByRole('button', { name: /^All Items\s+4$/ }).click()
  await page.getByRole('combobox', { name: 'Folder filter', exact: true }).selectOption('*')
  await page.getByRole('textbox', { name: 'Search vault', exact: true }).fill('')
  await expect(entryRows()).toHaveCount(4)
  for (const title of TITLES) await expect(entryRow(title)).toBeVisible()
  await expect(entryRows().first()).toContainText(LOGIN.title)
}

async function selectEntry(title: string): Promise<void> {
  await entryRow(title).click()
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  // Selecting an entry hides the list only below md (VaultScreen.tsx:491).
  const search = page.getByRole('textbox', { name: 'Search vault', exact: true })
  if (await page.getByRole('button', { name: 'Back to items', exact: true }).isVisible()) {
    await expect(search).toBeHidden()
  } else {
    await expect(search).toBeVisible()
    await expect(entryRow(title)).toBeVisible()
  }
}

async function beginEntry(
  kind: 'Login' | 'Card' | 'Address' | 'Note',
  title: string
): Promise<void> {
  await page.getByTitle('New entry', { exact: true }).click()
  await expect(page.getByText('New Entry', { exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: 'Kind', exact: true }).selectOption({ label: kind })
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill(title)
}

async function saveEntry(title: string): Promise<void> {
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  await expect(entryRow(title)).toBeVisible()
}

async function setTheme(mode: 'Light' | 'Dark'): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Primary navigation' })
  const selected = nav.getByRole('button', { name: `Theme: ${mode}`, exact: true })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await selected.isVisible()) break
    await nav.getByRole('button', { name: /^Theme:/ }).click()
  }
  await expect(selected).toBeVisible()
  // theme.ts applies this attribute; OS media emulation alone does not set the preference.
  await expect(page.locator('html')).toHaveAttribute('data-theme', mode.toLowerCase())
}

async function screenshot(name: string): Promise<void> {
  await page.screenshot({ path: path.join(SCREENSHOTS, name), animations: 'disabled' })
}

async function expectNoHorizontalOverflow(): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
      )
    )
    .toBe(true)
}

test.describe('Vault item kinds with demo data', () => {
  test.skip(!fs.existsSync(path.resolve('pro/package.json')), 'Pro is required for the Vault.')
  test.skip(targetIsPackaged(), 'This source test uses OFFGRID_PRO=1 to activate Pro.')
  test.setTimeout(180_000)

  test.beforeEach(async () => {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-vault-kinds-'))
    fs.mkdirSync(SCREENSHOTS, { recursive: true })
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
    await openVault()
    await expect(page.getByRole('heading', { name: 'Create Vault', exact: true })).toBeVisible()
    await page.getByLabel('Master password', { exact: true }).fill(MASTER_PASSWORD)
    await page.getByLabel('Confirm password', { exact: true }).fill(MASTER_PASSWORD)
    await page.getByRole('button', { name: 'Create Vault', exact: true }).click()
    // The unlocked status opens the list directly in this create flow.
    await expect(page.getByRole('button', { name: 'All Items', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Lock vault', exact: true })).toBeVisible()
    await expect(entryRows()).toHaveCount(0)
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

  test('creates each kind, checks filters and details, and captures light, dark and narrow views', async () => {
    await beginEntry('Login', LOGIN.title)
    await page.getByRole('textbox', { name: 'Username / Email', exact: true }).fill(LOGIN.username)
    await page.getByLabel('Password', { exact: true }).fill(LOGIN.password)
    await page.getByRole('textbox', { name: 'Primary URL', exact: true }).fill(LOGIN.urls[0])
    await page.getByRole('button', { name: 'Add URL', exact: true }).click()
    await page.getByRole('textbox', { name: 'URL 2', exact: true }).fill(LOGIN.urls[1])
    await page.getByLabel('TOTP secret', { exact: true }).fill(LOGIN.totp)
    // The input has a datalist, so its implicit role is combobox.
    await page.getByRole('combobox', { name: 'Folder', exact: true }).fill('Work')
    await page.getByRole('checkbox', { name: 'Favorite', exact: true }).check()
    await saveEntry(LOGIN.title)

    await beginEntry('Card', CARD.title)
    await page.getByRole('textbox', { name: 'Cardholder', exact: true }).fill(CARD.holder)
    await page.getByRole('textbox', { name: 'Brand', exact: true }).fill('Visa')
    await page.getByLabel('Card number', { exact: true }).fill(CARD.number)
    await page.getByRole('textbox', { name: 'Expiry', exact: true }).fill(CARD.expiry)
    await page.getByLabel('CVV', { exact: true }).fill(CARD.cvv)
    await saveEntry(CARD.title)

    await beginEntry('Address', ADDRESS_TITLE)
    for (const [label, value] of ADDRESS_FIELDS) {
      await page.getByRole('textbox', { name: label, exact: true }).fill(value)
    }
    await saveEntry(ADDRESS_TITLE)

    await beginEntry('Note', NOTE.title)
    await page.getByRole('textbox', { name: 'Notes', exact: true }).fill(NOTE.body)
    await saveEntry(NOTE.title)
    await expect(detailRow('Notes').getByText('••••••••••••', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Reveal notes', exact: true }).click()
    await expect(detailRow('Notes')).toContainText(NOTE.body)
    await page.getByRole('button', { name: 'Hide notes', exact: true }).click()
    await expect(detailRow('Notes').getByText('••••••••••••', { exact: true })).toBeVisible()

    await showList()
    await expect(page.getByRole('heading', { name: NOTE.title, exact: true })).toBeVisible()
    const folder = page.getByRole('combobox', { name: 'Folder filter', exact: true })
    await expect(folder.getByRole('option', { name: 'Work', exact: true })).toHaveCount(1)
    await folder.selectOption({ label: 'Work' })
    await expect(entryRows()).toHaveCount(1)
    await expect(entryRows().first()).toContainText(LOGIN.title)
    await folder.selectOption('*')

    for (const [category, title] of [
      ['Logins', LOGIN.title],
      ['Cards', CARD.title],
      ['Addresses', ADDRESS_TITLE],
      ['Notes', NOTE.title]
    ]) {
      // Category buttons include their count in the accessible name.
      await page.getByRole('button', { name: new RegExp(`^${category}\\s+1$`) }).click()
      await expect(entryRows()).toHaveCount(1)
      await expect(entryRow(title)).toBeVisible()
      for (const other of TITLES.filter((item) => item !== title)) {
        await expect(entryRow(other)).toHaveCount(0)
      }
    }
    await showList()
    await screenshot('vault-kinds-list-light.png')

    await selectEntry(LOGIN.title)
    await expect(detailRow('Folder')).toContainText('Work')
    await expect(detailRow('Favorite')).toContainText('Yes')
    await expect(detailRow('Username / Email')).toContainText(LOGIN.username)
    await expect(detailRow('Websites').getByRole('link')).toHaveCount(2)
    await expect(
      detailRow('Websites').getByRole('link', { name: LOGIN.urls[1], exact: true })
    ).toBeVisible()
    await expect(page.getByRole('link', { name: LOGIN.urls[0], exact: true })).toBeVisible()
    await expect(page.getByRole('status', { name: 'Authenticator code', exact: true })).toHaveText(
      /^\d{6}$/
    )
    const timeLeft = page.getByRole('progressbar', { name: 'Code time remaining', exact: true })
    await expect(timeLeft).toBeVisible()
    await expect(timeLeft).toHaveAttribute('value', /^(?:[1-9]|[12]\d|30)$/)
    await expect(detailRow('Authenticator code').getByText(/^(?:[1-9]|[12]\d|30)s$/)).toBeVisible()
    await expect(detailRow('Password').getByText('••••••••••••', { exact: true })).toBeVisible()
    await expect(page.getByText(LOGIN.password, { exact: true })).toHaveCount(0)
    await screenshot('vault-kinds-login-totp-light.png')

    await selectEntry(CARD.title)
    const number = detailRow('Card number')
    await expect(number.getByText('•••• 1111', { exact: true })).toBeVisible()
    await expect(entryRow(CARD.title)).toContainText('•••• 1111')
    await expect(detailRow('CVV').getByText('••••••••••••', { exact: true })).toBeVisible()
    await expect(page.getByText(CARD.number, { exact: true })).toHaveCount(0)
    await expect(page.getByText(CARD.cvv, { exact: true })).toHaveCount(0)
    await expect(detailRow('Cardholder')).toContainText(CARD.holder)
    await expect(detailRow('Expiry')).toContainText(CARD.expiry)
    await page.getByRole('button', { name: 'Reveal number', exact: true }).click()
    await expect(number.getByText(CARD.number, { exact: true })).toBeVisible()
    await expect(detailRow('CVV').getByText('••••••••••••', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Hide number', exact: true }).click()
    await expect(number.getByText('•••• 1111', { exact: true })).toBeVisible()
    await screenshot('vault-kinds-card-light.png')

    await selectEntry(ADDRESS_TITLE)
    for (const [label, value] of ADDRESS_FIELDS) {
      await expect(detailRow(label).getByText(value, { exact: true })).toBeVisible()
    }
    await screenshot('vault-kinds-address-light.png')

    await setTheme('Dark')
    // ThemeToggle.tsx:17-24 changes only the theme, so the vault and detail stay open.
    await expect(page.getByRole('button', { name: 'Lock vault', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: ADDRESS_TITLE, exact: true })).toBeVisible()
    await showList()
    await screenshot('vault-kinds-list-dark.png')
    await selectEntry(CARD.title)
    await expect(detailRow('Card number').getByText('•••• 1111', { exact: true })).toBeVisible()
    await screenshot('vault-kinds-card-dark.png')

    if (!app) throw new Error('Electron app is not running')
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      // The app minimum is 900px. Allow the requested narrow test size.
      window.setMinimumSize(800, 670)
      window.setSize(800, 700)
    })
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(800)
    // At 800px, md still applies: showList keeps the selected card beside the list.
    await showList()
    await expect(page.getByRole('heading', { name: CARD.title, exact: true })).toBeVisible()
    await expectNoHorizontalOverflow()
    await screenshot('vault-kinds-list-narrow.png')
    await selectEntry(CARD.title)
    await expect(detailRow('Card number').getByText('•••• 1111', { exact: true })).toBeVisible()
    await expectNoHorizontalOverflow()
    await screenshot('vault-kinds-card-narrow.png')
  })
})
