/**
 * APP-105 — Free/Pro isolation.
 *
 * A fresh free profile must keep every Pro destination discoverable, but route it
 * to the matching upgrade explanation. Merely visiting those explanations must
 * not activate capture, meetings, clipboard history, vault, voice, approvals,
 * search/CRM, or device-sync services behind the lock.
 *
 * This launches the real Electron app, uses the real sidebar and Settings UI,
 * and probes only the public preload/IPC boundary plus durable profile output.
 * No Off Grid module or store is mocked.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid } from './helpers/launch'
import { gotoSettings, navButton } from './helpers/settings'

type LockedFeature = {
  label: string
  route: string
  tagline: string
}

const LOCKED_FEATURES: readonly LockedFeature[] = [
  { label: 'Search', route: 'search', tagline: 'Search everything you’ve ever seen.' },
  { label: 'Day', route: 'day', tagline: 'Your day, planned for you.' },
  { label: 'Replay', route: 'replay', tagline: 'Rewind anything you saw.' },
  { label: 'Reflect', route: 'reflect', tagline: 'See where your time really goes.' },
  { label: 'Meetings', route: 'meetings', tagline: 'Record & transcribe meetings, locally.' },
  { label: 'Actions', route: 'actions', tagline: 'To-dos and actions, handled.' },
  { label: 'Entities', route: 'entities', tagline: 'A private graph of your work.' },
  { label: 'Voice', route: 'voice', tagline: 'Talk instead of type, fully local.' },
  {
    label: 'Vault',
    route: 'vault',
    tagline: 'Passwords and secrets, encrypted on this device.'
  },
  { label: 'Clipboard', route: 'clipboard', tagline: 'Every copy, kept and searchable.' },
  { label: 'Devices', route: 'devices', tagline: 'Your chats and settings, on every device.' },
  { label: 'Notifications', route: 'notifications', tagline: 'Approvals & to-dos, surfaced.' }
]

const SETTINGS_PLACEHOLDERS = [
  {
    title: 'Device sync',
    description: 'Pair your Mac and your phone and they stay in step'
  },
  {
    title: 'You',
    description: 'Tell Off Grid who you are'
  },
  {
    title: 'What Off Grid has learned',
    description: 'Preferences distilled from the suggestions you dismiss'
  }
] as const

const PROTECTED_IPC_CHANNELS = [
  'capture:status',
  'meeting:get-state',
  'voice:dictation:get-state',
  'clipboard:count',
  'vault:status',
  'approvals:list',
  'crm:search',
  'pro:sync:status'
] as const

const UPGRADE_SCREENSHOT = path.join(os.tmpdir(), 'offgrid-app105-locked-upgrade.png')
const SETTINGS_SCREENSHOT = path.join(os.tmpdir(), 'offgrid-app105-free-settings-placeholders.png')

let app: ElectronApplication
let page: Page
let profileDir: string

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-app105-free-'))
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profileDir,
      OFFGRID_PRO: '0',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)

  const expandSidebar = page.getByRole('button', { name: 'Expand sidebar' })
  if (await expandSidebar.isVisible().catch(() => false)) await expandSidebar.click()
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
})

test.afterAll(async () => {
  await app?.close().catch(() => {})
  if (profileDir && path.basename(profileDir).startsWith('offgrid-app105-free-')) {
    fs.rmSync(profileDir, { recursive: true, force: true })
  }
})

test('every locked Pro destination opens its matching upgrade explanation', async () => {
  for (const feature of LOCKED_FEATURES) {
    const button = navButton(page, feature.label)
    await expect(button, `${feature.label} remains discoverable in the free sidebar`).toBeVisible()
    await expect(
      button.getByRole('img', { name: 'Pro' }),
      `${feature.label} is visibly marked Pro`
    ).toBeVisible()

    await button.click()

    await expect(page).toHaveURL(new RegExp(`/${feature.route}$`))
    await expect(page.getByRole('heading', { name: feature.label, level: 1 })).toBeVisible()
    await expect(page.getByText(feature.tagline, { exact: true })).toBeVisible()
    await expect(page.getByText('Off Grid AI Pro · Available now', { exact: true })).toBeVisible()
    await expect(page.getByText('Everything in Pro', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Get Pro/ })).toHaveCount(1)
  }

  await page.screenshot({ path: UPGRADE_SCREENSHOT, fullPage: true })
})

test('free Settings shows the complete inert Pro catalogue without loading a Pro section', async () => {
  await gotoSettings(page)
  await expect(page).toHaveURL(/\/settings$/)
  await expect(
    page.getByText('Personalization & automation unlock with Pro', { exact: true })
  ).toBeVisible()

  for (const placeholder of SETTINGS_PLACEHOLDERS) {
    const title = page.getByRole('heading', { name: placeholder.title, level: 3 })
    await expect(title).toBeVisible()
    const card = title.locator('..')
    await expect(card.getByText('Pro', { exact: true })).toBeVisible()
    await expect(card.getByText(placeholder.description, { exact: false })).toBeVisible()
    // These are catalogue placeholders, not silently mounted Pro sections.
    await expect(card.locator('button, a')).toHaveCount(0)
    await expect
      .poll(() => card.evaluate((element) => getComputedStyle(element).filter))
      .toMatch(/^(none|blur\(0px\))$/)
  }

  await page.waitForTimeout(150)
  await page.screenshot({ path: SETTINGS_SCREENSHOT, fullPage: true })
})

test('visiting locked surfaces leaves every protected runtime and durable store uninitialized', async () => {
  const entitlement = await page.evaluate(() => {
    const api = window.api as typeof window.api & { proEntitlementBootstrapEnabled?: boolean }
    return {
      isPro: api.isPro,
      entitlementBootstrapEnabled: api.proEntitlementBootstrapEnabled
    }
  })
  expect(entitlement).toEqual({ isPro: false, entitlementBootstrapEnabled: false })

  const channelResults = await page.evaluate(async (channels) => {
    const results: Record<string, { rejected: boolean; message: string }> = {}
    for (const channel of channels) {
      try {
        await window.api.proInvoke?.(channel)
        results[channel] = { rejected: false, message: '' }
      } catch (error) {
        results[channel] = {
          rejected: true,
          message: error instanceof Error ? error.message : String(error)
        }
      }
    }
    return results
  }, PROTECTED_IPC_CHANNELS)

  for (const channel of PROTECTED_IPC_CHANNELS) {
    expect(
      channelResults[channel]?.rejected,
      `${channel} must not be registered for free users`
    ).toBe(true)
    expect(channelResults[channel]?.message).toContain('No handler registered')
  }

  // Clipboard quick-paste and dictation each create an auxiliary BrowserWindow when their Pro
  // service starts. A free session retains only the rendered application window.
  const rendererWindowCount = await app.evaluate(
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()).length
  )
  expect(rendererWindowCount).toBe(1)

  const forbiddenProfileArtifacts = [
    'captures',
    'meetings',
    'voice',
    'clip-files',
    'sync-knowledge-documents',
    'sync-shared-files',
    'vault.kdbx',
    'vault.recovery',
    '.vault-device'
  ]
  for (const relativePath of forbiddenProfileArtifacts) {
    expect(
      fs.existsSync(path.join(profileDir, relativePath)),
      `${relativePath} must not be created behind an upgrade screen`
    ).toBe(false)
  }
})
