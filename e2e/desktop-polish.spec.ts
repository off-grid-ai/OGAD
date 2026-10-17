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
    const button = page.getByRole('button', { name: /Continue|Start using Off Grid AI/i })
    if (!(await button.isVisible().catch(() => false))) return
    await button.click()
  }
}

async function expectVisibleKeyboardFocus(
  locator: Locator,
  label: string,
  outlineOffset = '2px'
): Promise<void> {
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
          // A field inside a focus surface (icon + input in one bordered box) is ringed by the
          // surface, not by itself (main.css [data-focus-surface]); read the ring where it is drawn.
          // 036819cbdf puts the palette ring on its command input wrapper, inset by 2px.
          const ringed =
            element.closest('[data-focus-surface], [data-slot="command-input-wrapper"]') ?? element
          const style = getComputedStyle(ringed)
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
      outlineOffset
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

  await collection.hover()
  await page.mouse.wheel(0, 10_000)
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
  // A long keyboard walk (every stop on Models, Settings and the palette), about 90 s on this Mac;
  // the default 60 s budget is for single journeys.
  test.setTimeout(180_000)
  const navigation = page.getByRole('navigation', { name: 'Primary navigation' })
  await navigation.getByRole('img', { name: 'Off Grid AI', exact: true }).click()
  await page.keyboard.press('Tab')

  // Hover opens the rail; its first control pins it open. Disabled history buttons are skipped.
  const sidebarPin = navigation.getByRole('button', { name: 'Pin sidebar', exact: true })
  // Anchored regexes rather than exact names: in a free build (OFFGRID_PRO=0) these two are locked, and
  // a locked item renders a lock icon whose title="Pro" joins the accessible name - the button is called
  // "Search Pro" here and "Search" in a pro build. Matching the start covers both, and still pins WHICH
  // destination receives focus, which is what this test is about.
  const searchNavigation = page.getByRole('button', { name: /^Search( Pro)?$/ })
  const dayNavigation = page.getByRole('button', { name: /^Day( Pro)?$/ })
  await expectVisibleKeyboardFocus(sidebarPin, 'sidebar pin')
  await page.keyboard.press('Tab')
  // Clicking the logo opens the rail before keyboard traversal begins.
  await expectVisibleKeyboardFocus(
    navigation.getByRole('button', { name: 'Discover', exact: true }),
    'Discover group'
  )
  await expect(sidebarPin).toBeVisible()
  await page.keyboard.press('Tab')
  await expectVisibleKeyboardFocus(searchNavigation, 'first navigation destination')
  await page.keyboard.press('Tab')
  await expectVisibleKeyboardFocus(dayNavigation, 'second navigation destination')

  // Continue through the rest of the real navigation and Models header. This keeps
  // Chromium in keyboard modality; a programmatic focus jump would not prove that
  // :focus-visible survives the user's actual traversal.
  const modelTypes = page.getByRole('radiogroup', { name: 'Model types' })
  await tabUntilFocused(modelTypes.getByRole('radio', { checked: true }), 'model type', 32)
  await page.keyboard.press('End')
  await expectVisibleKeyboardFocus(
    modelTypes.getByRole('radio', { name: 'Storage', exact: true }),
    'Storage tab'
  )
  await page.keyboard.press('Home')
  await expectVisibleKeyboardFocus(
    modelTypes.getByRole('radio', { checked: true }),
    'first model type'
  )
  await page.keyboard.press('Tab')
  const modelSearch = page.getByPlaceholder('Search HuggingFace…')
  await expectVisibleKeyboardFocus(modelSearch, 'model search field')

  for (const name of ['MTP downloads: Off', 'All sources', 'Any size', 'Sort']) {
    await page.keyboard.press('Tab')
    await expectVisibleKeyboardFocus(
      page.getByRole(name === 'MTP downloads: Off' ? 'button' : 'combobox', { name, exact: true }),
      `${name} filter`
    )
  }
  await page.keyboard.press('Tab')
  const memory = page.getByRole('radiogroup', { name: 'Fits in memory' })
  await expectVisibleKeyboardFocus(
    memory.getByRole('radio', { name: 'Any', exact: true }),
    'any memory size'
  )
  for (const size of [2, 4, 6, 8, 16]) {
    await page.keyboard.press('ArrowRight')
    await expectVisibleKeyboardFocus(
      memory.getByRole('radio', { name: `≤${size}GB`, exact: true }),
      `${size}GB quick filter`
    )
  }
  await page.keyboard.press('Home')
  await expect(memory.getByRole('radio', { name: 'Any', exact: true })).toBeChecked()
  await page.keyboard.press('Tab')
  await expectVisibleKeyboardFocus(
    page.getByRole('radio', { name: 'Grid view', exact: true }),
    'grid layout'
  )
  await page.keyboard.press('Tab')
  const useCases = page.getByRole('radiogroup', { name: 'Use case', exact: true })
  await expectVisibleKeyboardFocus(
    useCases.getByRole('radio', { name: 'All', exact: true }),
    'all use cases'
  )
  for (const useCase of ['General', 'Coding', 'Writing', 'Legal', 'Vision', 'Lightweight']) {
    await page.keyboard.press('ArrowRight')
    await expectVisibleKeyboardFocus(
      useCases.getByRole('radio', { name: useCase, exact: true }),
      `${useCase} use-case filter`
    )
  }

  await page.keyboard.press('Home')
  await expect(useCases.getByRole('radio', { name: 'All', exact: true })).toBeChecked()

  const firstCard = page
    .getByRole('list', { name: 'Models available to download' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: 'Bonsai 2 27B', exact: true }) })
  // Capability filters precede the cards in keyboard order.
  await tabUntilFocused(
    firstCard.getByRole('button', { name: 'Bonsai 2 27B', exact: true }),
    'model detail trigger',
    24
  )
  await page.keyboard.press('Tab')
  await expectVisibleKeyboardFocus(
    firstCard.getByRole('button', { name: 'Download', exact: true }),
    'primary download action'
  )
  await page.keyboard.press('Tab')
  await expectVisibleKeyboardFocus(
    firstCard.getByRole('button', { name: 'Details', exact: true }),
    'model details action'
  )

  // The production command palette is the app's real modal dialog. It must move
  // focus into its form, keep keyboard focus inside, and retain the visible ring.
  await page.keyboard.press('Meta+K')
  const dialog = page.getByRole('dialog', { name: 'Search Off Grid AI' })
  await expect(dialog).toBeVisible()
  // The REAL placeholder. This said 'Search everything…', which is not a substring of what the palette
  // renders ('Search everything, or jump to a screen…'), so the locator matched nothing and the focus
  // assertion failed against an element that was never there - the palette focuses its input correctly.
  // Anchored on the stable half of the string so a copy tweak to the tail does not break it again.
  const dialogSearch = dialog.getByPlaceholder(/^Search everything/)
  await expectVisibleKeyboardFocus(dialogSearch, 'dialog search field')
  await page.keyboard.press('Tab')
  await expectVisibleKeyboardFocus(
    dialog.getByRole('listbox').locator('../..'),
    'dialog results scroller'
  )
  await page.keyboard.press('Tab')
  await expectVisibleKeyboardFocus(dialogSearch, 'dialog focus trap')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('reduced motion keeps the detail layer reachable and Escape preserves the collection (#152, #153)', async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page
    .getByRole('list', { name: 'Models available to download' })
    .getByRole('button', { name: 'Bonsai 2 27B', exact: true })
    .click()

  const detail = page.getByRole('dialog', { name: 'Bonsai 2 27B details', exact: true })
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
