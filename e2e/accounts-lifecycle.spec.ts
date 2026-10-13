/**
 * Every account kind can be added, read, changed and removed in the real app (Pro, dev build,
 * fresh temp profile). Boundaries replaced: the OS folder chooser (a synthetic vault) and the
 * system browser (shell.openExternal records the consent URL instead of opening it). A real
 * Google or Microsoft consent needs a person and is checked by hand; this spec proves everything
 * up to that page, including which services each sign-in asks for.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchOffGrid } from './helpers/launch'
import { completeOnboarding } from './helpers/onboarding'

const PRO_PRESENT = fs.existsSync(path.resolve('pro/package.json'))
const MCP_SERVER = path.resolve('e2e/fixtures/accounts-mcp-connector.mjs')
const SHOTS = process.env.OFFGRID_E2E_SHOTS

let app: ElectronApplication
let page: Page
let profileDir: string

const shot = async (name: string): Promise<void> => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

/** Consent URLs the app asked the system browser to open, oldest first. */
const opened = (): Promise<string[]> =>
  app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened.slice())

const nextConsent = async (host: string): Promise<URL> => {
  let found: string | undefined
  await expect
    .poll(
      async () => {
        found = (await opened()).reverse().find((u) => new URL(u).hostname === host)
        return Boolean(found)
      },
      { timeout: 20_000 }
    )
    .toBe(true)
  await app.evaluate(() => {
    ;(globalThis as unknown as { __opened: string[] }).__opened.length = 0
  })
  return new URL(found!)
}

const openIntegrations = async (): Promise<void> => {
  const nav = page.getByRole('navigation', { name: 'Primary navigation' })
  await nav.hover()
  await nav.getByRole('button', { name: 'Integrations', exact: true }).click()
  // The first launch of a run is cold: give the app time to reach the screen.
  await expect(page.getByRole('heading', { name: 'Integrations' })).toBeVisible({ timeout: 60_000 })
}

const card = (name: string): ReturnType<Page['getByRole']> =>
  page.getByRole('listitem', { name, exact: true })

test.beforeEach(async () => {
  test.skip(!PRO_PRESENT, 'pro package not present')
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-accounts-'))
  app = await launchOffGrid({
    env: { ...process.env, OFFGRID_USER_DATA: profileDir, OFFGRID_PRO: '1', NODE_ENV: 'production' }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __opened: string[] }
    g.__opened = []
    shell.openExternal = async (url: string) => {
      g.__opened.push(url)
    }
  })
  await completeOnboarding(page)
  await openIntegrations()
})

test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  fs.rmSync(profileDir, { recursive: true, force: true })
})

for (const provider of [
  {
    name: 'Google',
    host: 'accounts.google.com',
    drop: 'Drive',
    keeps: 'gmail.readonly',
    dropped: 'drive.readonly',
    ownId: '123456789012-synthetic.apps.googleusercontent.com',
    ownSecret: 'synthetic-secret'
  },
  {
    name: 'Microsoft',
    host: 'login.microsoftonline.com',
    drop: 'OneDrive',
    keeps: 'Mail.Read',
    dropped: 'Files.Read',
    ownId: '00000000-1111-4222-8333-444444444444',
    ownSecret: null
  }
] as const) {
  test(`${provider.name}: asks only for the chosen services, with Off Grid AI's app or your own`, async () => {
    const google = provider.name === 'Google'
    await card(provider.name).getByRole('button', { name: 'Connect', exact: true }).click()
    const panel = page.getByRole('dialog', { name: `Connect ${provider.name}` })
    await expect(panel).toBeVisible()
    await panel.getByRole('checkbox', { name: provider.drop }).uncheck()
    await shot(`${provider.name.toLowerCase()}-choose-services`)

    // Connect with Off Grid AI: the registration built into this app.
    await panel.getByRole('button', { name: `Connect ${provider.name}` }).click()
    const builtIn = await nextConsent(provider.host)
    const builtInClient = builtIn.searchParams.get('client_id')!
    expect(builtInClient).toBeTruthy()
    expect(builtIn.searchParams.get('scope')).toContain(provider.keeps)
    expect(builtIn.searchParams.get('scope')).not.toContain(provider.dropped)
    expect(builtIn.searchParams.get('code_challenge_method')).toBe('S256')
    await panel.getByRole('button', { name: 'Cancel' }).click()
    await expect(panel.getByRole('button', { name: `Connect ${provider.name}` })).toBeEnabled()

    // Use your own application: client ID (and Google's secret) saved on this device.
    await panel.getByLabel('Connection option').selectOption('own')
    await panel.getByLabel('Application client ID').fill(provider.ownId)
    if (provider.ownSecret) await panel.getByLabel('Client secret').fill(provider.ownSecret)
    else await expect(panel.getByLabel('Client secret')).toHaveCount(0)
    await panel.getByRole('button', { name: 'Save application' }).click()
    await expect(panel.getByText('Application saved on this device.')).toBeVisible()
    await shot(`${provider.name.toLowerCase()}-own-app`)
    await panel.getByRole('button', { name: `Connect ${provider.name}` }).click()
    const own = await nextConsent(provider.host)
    expect(own.searchParams.get('client_id')).toBe(provider.ownId)
    expect(own.searchParams.get('client_id')).not.toBe(builtInClient)
    expect(own.searchParams.get('scope')).not.toContain(provider.dropped)
    await panel.getByRole('button', { name: 'Cancel' }).click()

    // A cancelled sign-in leaves no half-made account behind.
    await panel.getByRole('button', { name: `Close ${provider.name} setup` }).click()
    await expect(
      card(provider.name).getByRole('button', { name: 'Connect', exact: true })
    ).toBeVisible()
    expect(google || provider.ownSecret === null).toBe(true)
  })
}

test('Obsidian: add two vaults, change one, remove one after confirming', async () => {
  const vault = (name: string): string => {
    const dir = path.join(profileDir, 'vaults', name)
    fs.mkdirSync(path.join(dir, '.obsidian'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'Synthetic note.md'), `# ${name}\nA synthetic note.\n`)
    return dir
  }
  const choose = (dir: string): Promise<void> =>
    app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as never
    }, dir)
  const obsidian = card('Obsidian')
  const vaults = obsidian.getByRole('list', { name: 'Obsidian vaults' })

  await choose(vault('Field notes'))
  await obsidian.getByRole('button', { name: 'Choose vault' }).click()
  await expect(vaults.getByRole('listitem', { name: 'Field notes' })).toBeVisible()

  await choose(vault('Recipes'))
  await obsidian.getByRole('button', { name: 'Add vault' }).click()
  await expect(vaults.getByRole('listitem', { name: 'Recipes' })).toBeVisible()

  // The same folder twice is refused.
  await obsidian.getByRole('button', { name: 'Add vault' }).click()
  // The reason is shown as written, without Electron's IPC wrapper, and there is no Retry:
  // nothing failed to load.
  await expect(page.getByRole('alert')).toHaveText(
    'The vault Recipes is already connected. Choose a different vault.'
  )
  await expect(obsidian.getByRole('button', { name: 'Retry' })).toHaveCount(0)

  await choose(vault('Recipes 2026'))
  await vaults.getByRole('button', { name: 'Change Recipes' }).click()
  await expect(vaults.getByRole('listitem', { name: 'Recipes 2026' })).toBeVisible()
  await expect(vaults.getByRole('listitem', { name: 'Recipes', exact: true })).toHaveCount(0)
  await shot('obsidian-two-vaults')

  await vaults.getByRole('button', { name: 'Remove Field notes' }).click()
  await vaults
    .getByRole('alertdialog', { name: 'Remove Field notes?' })
    .getByRole('button', { name: 'Remove' })
    .click()
  await expect(vaults.getByRole('listitem', { name: 'Field notes' })).toHaveCount(0)
  await expect(vaults.getByRole('listitem', { name: 'Recipes 2026' })).toBeVisible()
})

test('MCP connector: add, test, rename, remove after confirming', async () => {
  await page.getByRole('button', { name: /Custom/ }).click()
  await page.getByPlaceholder('Name').fill('Synthetic notes')
  await page.getByRole('button', { name: 'stdio (local)' }).click()
  await page.getByPlaceholder('command (e.g. npx)').fill(process.execPath)
  await page.getByPlaceholder('args').fill(MCP_SERVER)
  await page.getByRole('button', { name: 'Add', exact: true }).click()

  await page
    .getByRole('button', { name: /Synthetic notes/ })
    .first()
    .click()
  await expect(page.getByRole('heading', { name: 'Synthetic notes' })).toBeVisible()
  await page.getByRole('button', { name: 'Test' }).click()
  await expect(page.getByText('connected', { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('lookup_note')).toBeVisible()

  await page.getByRole('button', { name: 'Edit' }).click()
  const form = page.getByRole('form', { name: 'Edit Synthetic notes' })
  await form.getByLabel('Name').fill('Team notebook')
  await form.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { name: 'Team notebook' })).toBeVisible()
  await expect(page.getByText('connected', { exact: true })).toBeVisible()
  await shot('mcp-connector-edited')

  await page.getByRole('button', { name: 'Remove Team notebook' }).click()
  await page
    .getByRole('alertdialog', { name: 'Remove Team notebook?' })
    .getByRole('button', { name: 'Remove' })
    .click()
  await expect(page.getByRole('heading', { name: 'Team notebook' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Team notebook/ })).toHaveCount(0)
})
