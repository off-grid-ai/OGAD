/**
 * Explore surface - the capability-panel catalog renders on both of its placements
 * (the Explore screen and the chat empty state) and never leaks a preset's raw
 * prompt onto a card: cards show the label + blurb only, the prompt stays behind
 * the tap. Free build, fresh profile - the catalog needs no model and no seed.
 *
 * Screenshots land in e2e/screenshots/ for PR evidence.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchOffGrid } from './helpers/launch'
import { completeOnboarding } from './helpers/onboarding'
import os from 'os'
import path from 'path'
import fs from 'fs'

let app: ElectronApplication
let page: Page
let userDataDir: string

test.beforeAll(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-e2e-explore-'))
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_PRO: '0',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)
  try {
    await page.getByRole('button', { name: 'Expand sidebar' }).click({ timeout: 4000 })
  } catch {
    /* already open */
  }
})

test.afterAll(async () => {
  await app?.close()
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

test('the Explore screen renders capability panels with labels, never the prompt', async () => {
  await page.getByRole('button', { name: 'Explore', exact: true }).first().click()
  await expect(page.getByRole('heading', { level: 1, name: 'Explore' })).toBeVisible()

  // Every capability panel is on screen.
  for (const panel of [
    'Browse the web for you',
    'Drive your Mac',
    'Build client-ready work',
    "Remembers what you've seen",
    "Your Mac's tools, from your phone"
  ]) {
    await expect(page.getByText(panel, { exact: true })).toBeVisible()
  }

  // A card carries its label + blurb - the seeded prompt never appears on the surface.
  await expect(page.getByTestId('explore-preset-find-flight')).toBeVisible()
  await expect(page.getByText('Find me a flight to book', { exact: false })).toHaveCount(0)

  // A gated card says why it cannot just run.
  await expect(page.getByTestId('explore-preset-phone-summarize')).toContainText(/paired phone/i)

  await page.screenshot({ path: 'e2e/screenshots/explore-screen.png' })
})

test('every Explore card opens its intake form inside Chat before a run starts', async () => {
  for (const presetId of [
    'find-flight',
    'best-nearby',
    'price-compare',
    'play-music',
    'crop-screenshot',
    'draft-reply',
    'proposal-deck',
    'work-today',
    'that-article',
    'phone-summarize'
  ]) {
    await page.getByRole('button', { name: 'Explore', exact: true }).first().click()
    await page.getByTestId(`explore-preset-${presetId}`).click()
    await expect(page.getByTestId(`preset-intake-${presetId}`)).toBeVisible()
  }
})

test('proposal intake collects the complete brief before enabling chat', async () => {
  await page.getByRole('button', { name: 'Explore', exact: true }).first().click()
  await page.getByTestId('explore-preset-proposal-deck').click()
  const setup = page.getByTestId('preset-intake-proposal-deck')
  await expect(setup).toBeVisible()
  await expect(setup.getByRole('textbox', { name: /Company/ })).toHaveValue('')
  await expect(setup.getByRole('textbox', { name: /Meeting context/ })).toHaveValue('')
  await expect(setup.getByRole('textbox', { name: /Content folder/ })).toHaveValue('')
  await expect(setup.getByRole('textbox', { name: /Save under/ })).toHaveValue('')
  await expect(setup.getByRole('button', { name: 'Start in chat' })).toBeDisabled()
  await setup.getByRole('textbox', { name: /Company/ }).fill('Acme')
  await setup.getByRole('textbox', { name: /Meeting context/ }).fill('Plan the product launch.')
  await setup.getByRole('textbox', { name: /Content folder/ }).fill('/tmp/client-material')
  await setup.getByRole('textbox', { name: /Save under/ }).fill('/tmp/client-output')
  await expect(setup.getByRole('button', { name: 'Start in chat' })).toBeEnabled()
  await page.screenshot({ path: 'e2e/screenshots/explore-proposal-setup.png' })
})

test('the chat empty state reuses the same catalog with its compact intro', async () => {
  await page.getByRole('button', { name: 'Chat', exact: true }).first().click()
  await expect(page.getByText('Explore what Off Grid AI can do')).toBeVisible()
  await expect(page.getByTestId('explore-preset-best-nearby')).toBeVisible()
  await page.screenshot({ path: 'e2e/screenshots/explore-chat-empty.png' })
})
