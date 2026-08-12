import { test, expect, type ElectronApplication, type Page, type Locator } from '@playwright/test'
import { launchOffGrid } from './helpers/launch'
import fs from 'fs'
import os from 'os'
import path from 'path'

let app: ElectronApplication
let page: Page
let userDataDir: string

async function finishOnboarding(): Promise<void> {
  for (let step = 0; step < 6; step += 1) {
    const button = page.getByRole('button', { name: /Continue|Start using Off Grid/i })
    if (!(await button.isVisible().catch(() => false))) return
    await button.click()
  }
}

async function expectVisibleKeyboardFocus(locator: Locator, label: string): Promise<void> {
  await expect(locator, `${label} receives focus in the expected order`).toBeFocused()
  const primaryColor = await page.evaluate(() => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--og-primary)'
    document.body.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  })
  await expect
    .poll(
      () =>
        locator.evaluate((element) => {
          const style = getComputedStyle(element)
          return {
            focusVisible: element.matches(':focus-visible'),
            outlineStyle: style.outlineStyle,
            outlineWidth: style.outlineWidth,
            outlineColor: style.outlineColor,
            outlineOffset: style.outlineOffset
          }
        }),
      { message: `${label} settles to the exact token-based focus treatment` }
    )
    .toEqual({
      focusVisible: true,
      outlineStyle: 'solid',
      outlineWidth: '2px',
      outlineColor: primaryColor,
      outlineOffset: '2px'
    })
}

async function tabUntilFocused(locator: Locator, label: string, maxTabs: number): Promise<void> {
  for (let index = 0; index < maxTabs; index += 1) {
    await page.keyboard.press('Tab')
    if (await locator.evaluate((element) => element === document.activeElement)) {
      await expectVisibleKeyboardFocus(locator, label)
      return
    }
  }
  throw new Error(`${label} was not reached within ${maxTabs} Tab presses`)
}

test.beforeAll(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-desktop-polish-'))
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_PRO: '0',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  // Reduced motion disables the decorative infinite .og-shooting-star animation (it honors
  // prefers-reduced-motion) so the page reaches a stable state for keyboard-focus assertions.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForLoadState('domcontentloaded')
  await finishOnboarding()
  await expect(page.getByRole('heading', { name: 'Models' })).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

test('window resize adds collection columns while filter context remains reachable (#150)', async () => {
  const collection = page.getByRole('list', { name: 'Models available to download' })
  await expect(collection).toBeVisible()

  await page.setViewportSize({ width: 1280, height: 760 })
  await expect
    .poll(() =>
      collection.evaluate(
        (element) => getComputedStyle(element).gridTemplateColumns.split(' ').length
      )
    )
    .toBe(3)

  await collection.evaluate((element) => {
    const scroller = element.parentElement
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  })
  await expect(page.getByPlaceholder('Search HuggingFace…')).toBeVisible()

  await page.setViewportSize({ width: 1800, height: 900 })
  await expect
    .poll(() =>
      collection.evaluate(
        (element) => getComputedStyle(element).gridTemplateColumns.split(' ').length
      )
    )
    .toBe(4)
})

test('keyboard focus follows navigation, form, dialog, and primary-action order (#151)', async () => {
  await page.locator('body').click({ position: { x: 2, y: 2 } })
  await page.keyboard.press('Tab')

  // 'Collapse sidebar': the rail opens EXPANDED, so its toggle offers the action available from here.
  // There is no 'Expand sidebar' button to focus until someone collapses it. What this test is about is
  // unchanged - the sidebar toggle is the first thing Tab reaches.
  const sidebarToggle = page.getByRole('button', { name: 'Collapse sidebar' })
  // Anchored regexes rather than exact names: in a free build (OFFGRID_PRO=0) these two are locked, and
  // a locked item renders a lock icon whose title="Pro" joins the accessible name - the button is called
  // "Search Pro" here and "Search" in a pro build. Matching the start covers both, and still pins WHICH
  // destination receives focus, which is what this test is about.
  const searchNavigation = page.getByRole('button', { name: /^Search( Pro)?$/ })
  const dayNavigation = page.getByRole('button', { name: /^Day( Pro)?$/ })
  await expectVisibleKeyboardFocus(sidebarToggle, 'sidebar toggle')
  await page.keyboard.press('Tab')
  await expectVisibleKeyboardFocus(searchNavigation, 'first navigation destination')
  await page.keyboard.press('Tab')
  await expectVisibleKeyboardFocus(dayNavigation, 'second navigation destination')

  // Continue through the rest of the real navigation and Models header. This keeps
  // Chromium in keyboard modality; a programmatic focus jump would not prove that
  // :focus-visible survives the user's actual traversal.
  await tabUntilFocused(page.getByRole('button', { name: /^Storage\b/ }), 'Storage tab', 32)
  await page.keyboard.press('Tab')
  const modelSearch = page.getByPlaceholder('Search HuggingFace…')
  await expectVisibleKeyboardFocus(modelSearch, 'model search field')

  for (const name of ['All sources', 'Any size', 'Sort: Recommended']) {
    await page.keyboard.press('Tab')
    await expectVisibleKeyboardFocus(
      page.getByRole('button', { name, exact: true }),
      `${name} filter`
    )
  }
  for (const size of [2, 4, 6, 8, 16]) {
    await page.keyboard.press('Tab')
    await expectVisibleKeyboardFocus(
      page.getByRole('button', { name: `≤${size}GB`, exact: true }),
      `${size}GB quick filter`
    )
  }
  for (const useCase of [
    'General',
    'Coding',
    'Writing',
    'Legal',
    'Vision',
    'Lightweight',
    'Challenger' // the catalog exposes a Challenger use-case chip after Lightweight
  ]) {
    await page.keyboard.press('Tab')
    await expectVisibleKeyboardFocus(
      page.getByRole('button', { name: useCase, exact: true }),
      `${useCase} use-case filter`
    )
  }

  const firstCard = page
    .getByRole('list', { name: 'Models available to download' })
    .getByRole('listitem')
    .first()
  const cardButtons = firstCard.getByRole('button')
  await page.keyboard.press('Tab')
  await expectVisibleKeyboardFocus(cardButtons.nth(0), 'model detail trigger')
  await page.keyboard.press('Tab')
  await expectVisibleKeyboardFocus(cardButtons.nth(1), 'model details action')
  await page.keyboard.press('Tab')
  await expectVisibleKeyboardFocus(
    firstCard.getByRole('button', { name: 'Download', exact: true }),
    'primary download action'
  )

  // The production command palette is the app's real modal dialog. It must move
  // focus into its form, keep keyboard focus inside, and retain the visible ring.
  await page.keyboard.press('Meta+K')
  const dialog = page.getByRole('dialog', { name: 'Search Off Grid' })
  await expect(dialog).toBeVisible()
  // The REAL placeholder. This said 'Search everything…', which is not a substring of what the palette
  // renders ('Search everything, or jump to a screen…'), so the locator matched nothing and the focus
  // assertion failed against an element that was never there - the palette focuses its input correctly.
  // Anchored on the stable half of the string so a copy tweak to the tail does not break it again.
  const dialogSearch = dialog.getByPlaceholder(/^Search everything/)
  await expectVisibleKeyboardFocus(dialogSearch, 'dialog search field')
  await page.keyboard.press('Tab')
  await expectVisibleKeyboardFocus(dialogSearch, 'dialog focus trap')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('reduced motion keeps the detail layer reachable and Escape preserves the collection (#152, #153)', async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const firstCard = page.getByRole('listitem').first()
  await firstCard.getByRole('button').first().click()

  const detail = page.locator('.fixed.inset-0.z-50.flex.justify-end > div.relative')
  await expect(detail).toBeVisible()
  const transitionDuration = await detail.evaluate(
    (element) => getComputedStyle(element).transitionDuration
  )
  expect(Number.parseFloat(transitionDuration)).toBeLessThanOrEqual(0.001)

  await page.keyboard.press('Escape')
  await expect(detail).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Models' })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Models available to download' })).toBeVisible()
})
