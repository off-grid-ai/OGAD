import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid } from './helpers/launch'

// The real built app. A focused field shows one focus mark: the beam, following the field's own
// rounded corners. No ring, glow or square box is drawn inside it. And the palette's results panel
// meets its footer flush, without rounded corners curving in above the footer's divider.

let app: ElectronApplication | null = null
let page: Page
let profileDir = ''

test.describe.configure({ timeout: 120_000 })

test.beforeAll(async () => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-palette-focus-'))
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profileDir,
      OFFGRID_PRO: '1',
      OFFGRID_E2E_HEADLESS: '1',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  page.on('pageerror', (error) => console.error(`[renderer error] ${error.stack ?? error.message}`))
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)
})

// Open the palette from the keyboard and return its search field. Each test opens its own.
async function openPalette(): Promise<ReturnType<Page['getByRole']>> {
  if (!(await page.locator('[data-slot=command-footer]').isVisible().catch(() => false))) {
    await page.keyboard.press('Meta+K')
  }
  const search = page.getByRole('combobox', { name: 'Search everything' })
  await expect(search).toBeFocused()
  return search
}

// True when a computed box-shadow paints nothing: `none`, or only fully transparent layers.
const paintsNothing = (shadow: string): boolean =>
  shadow === 'none' ||
  (shadow.match(/rgba?\([^)]*\)/g) ?? []).every((colour) => /,\s*0\)$/.test(colour))

test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  fs.rmSync(profileDir, { recursive: true, force: true })
})

test('the focused search field shows only the beam, on its own rounded corners', async () => {
  const search = await openPalette()
  // The beam is drawn round the outermost field slot; give it a moment to arrive.
  await expect(page.locator('[data-slot=field-focus-beam]').first()).toBeAttached()

  const frames = await search.evaluate((input) => {
    const control = input.closest<HTMLElement>('[data-slot=input-control]')!
    const group = control.parentElement!.closest<HTMLElement>('[data-slot=autocomplete-input-group]')!
    const style = (element: Element): CSSStyleDeclaration => getComputedStyle(element)
    return {
      inputOutline: style(input).outlineStyle,
      controlShadow: style(control).boxShadow,
      groupShadow: style(group).boxShadow,
      controlRadius: style(control).borderTopLeftRadius,
      groupRadius: style(group).borderTopLeftRadius
    }
  })
  expect(frames.inputOutline).toBe('none')
  // No ring or glow inside the beam: any shadow left paints nothing.
  expect(paintsNothing(frames.controlShadow), frames.controlShadow).toBe(true)
  expect(paintsNothing(frames.groupShadow), frames.groupShadow).toBe(true)
  // The beam inherits the group's corners, so the group must carry the field's corners.
  expect(frames.groupRadius).toBe(frames.controlRadius)
  expect(frames.groupRadius).not.toBe('0px')
  await page.screenshot({ path: 'e2e/screenshots/command-palette-focus.png' })
})

test("the results panel meets the footer flush, with square bottom corners", async () => {
  await openPalette()
  const panelBottom = await page.locator('[data-slot=command-footer]').evaluate((footer) => {
    const panel = footer.previousElementSibling as HTMLElement | null
    return panel ? getComputedStyle(panel).borderBottomLeftRadius : 'no panel before the footer'
  })
  expect(panelBottom).toBe('0px')
})
