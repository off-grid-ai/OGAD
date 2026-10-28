import { test, expect, type ElectronApplication, type Page, type Locator } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchOffGrid } from './helpers/launch'
import { completeOnboarding } from './helpers/onboarding'
import { gotoSettings, navButton, openSettingsSection } from './helpers/settings'

// Settings > UI > Hover and click animations. Off, nothing moves or flares under the pointer: the
// sheen on a hovered button, a primary button's halo, sibling cards fading back, a card edge
// flashing as a click wave passes, and plain buttons pressing in. On, all of it returns.
// Colours, borders, focus and the breathing background are not this switch's business.

let app: ElectronApplication
let page: Page
let userDataDir: string

const CARD = ':is([data-og-living],[data-slot=card],[data-og-surface=glow])'

interface Motion {
  siblingOpacity: string
  edgeFlash: number
  plainPress: string
  sheen: string
  haloFlares: boolean
}

const away = (): Promise<void> => page.mouse.move(2, 2)

/** The to-do rows on the Day screen: a group of sibling cards. */
async function cardGroup(): Promise<Locator> {
  await navButton(page, 'Day').click()
  const group = page.locator(`:has(> ${CARD} ~ ${CARD})`).filter({ hasText: '[ui-lane] water' })
  await expect(group).toHaveCount(1)
  return group.locator(`> ${CARD}`)
}

async function measure(): Promise<Motion> {
  const cards = await cardGroup()
  await away()
  await cards.nth(0).hover()
  await page.waitForTimeout(700)
  const siblingOpacity = await cards.nth(1).evaluate((card) => getComputedStyle(card).opacity)

  // Press the empty lower edge of a card and watch every card edge while the wave travels.
  await away()
  const face = (await cards.nth(1).boundingBox())!
  await page.mouse.move(face.x + face.width - 12, face.y + face.height - 6)
  await page.mouse.down()
  await page.mouse.up()
  let edgeFlash = 0
  for (let sample = 0; sample < 14; sample += 1) {
    await page.waitForTimeout(40)
    edgeFlash = Math.max(
      edgeFlash,
      await page
        .locator('[data-og-living]')
        .evaluateAll((all) =>
          Math.max(
            0,
            ...all.map(
              (card) => parseFloat(getComputedStyle(card).getPropertyValue('--og-edge-a')) || 0
            )
          )
        )
    )
  }

  // A plain button (a Video idea card) held down, released off it so nothing is clicked.
  await navButton(page, 'Video').click()
  const plain = page.locator('button:not([data-slot])').filter({ hasText: /red fox/i })
  await expect(plain).toBeVisible()
  const middle = (await plain.boundingBox())!
  await page.mouse.move(middle.x + middle.width / 2, middle.y + middle.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(250)
  const plainPress = await plain.evaluate((button) => getComputedStyle(button).scale)
  await away()
  await page.mouse.up()

  // The primary button in Report a problem.
  await gotoSettings(page)
  await openSettingsSection(page, 'Analytics')
  await page.getByRole('button', { name: /report a problem/i }).click()
  const primary = page.getByRole('dialog').getByRole('button', { name: /email us/i })
  await expect(primary).toBeVisible()
  await away()
  await page.waitForTimeout(600)
  const rest = await primary.evaluate((button) => getComputedStyle(button).boxShadow)
  await primary.hover()
  await page.waitForTimeout(150)
  const sheen = await primary.evaluate(
    (button) => getComputedStyle(button, '::after').animationName
  )
  await page.waitForTimeout(600)
  const haloFlares =
    (await primary.evaluate((button) => getComputedStyle(button).boxShadow)) !== rest
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  return { siblingOpacity, edgeFlash, plainPress, sheen, haloFlares }
}

async function setAnimations(on: boolean): Promise<void> {
  await gotoSettings(page)
  await openSettingsSection(page, 'UI')
  const toggle = page.getByRole('switch', { name: /hover and click animations/i })
  await expect(toggle).toHaveAttribute('aria-checked', on ? 'false' : 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', on ? 'true' : 'false')
}

test.beforeAll(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-ui-animations-'))
  app = await launchOffGrid({
    env: { ...process.env, OFFGRID_USER_DATA: userDataDir, OFFGRID_PRO: '1' }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)
  await navButton(page, 'Day').click()
  const jot = page.getByPlaceholder(/jot a to-do/i)
  for (const todo of ['[ui-lane] water the plants', '[ui-lane] water the garden']) {
    await jot.fill(todo)
    await jot.press('Enter')
    await expect(page.getByText(todo)).toBeVisible()
  }
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

test('turning off hover and click animations stills every pointer motion, and on brings it back', async () => {
  const before = await measure()
  expect(before.siblingOpacity, 'a hovered card fades its siblings').not.toBe('1')
  expect(before.edgeFlash, 'a click wave flashes card edges').toBeGreaterThan(0)
  expect(parseFloat(before.plainPress), 'a plain button presses in').toBeLessThan(1)
  expect(before.sheen, 'a hovered button carries the sheen').toBe('og-alive-sheen')
  expect(before.haloFlares, 'a hovered primary button flares its halo').toBe(true)

  await setAnimations(false)
  expect(await measure()).toEqual({
    siblingOpacity: '1',
    edgeFlash: 0,
    plainPress: 'none',
    sheen: 'none',
    haloFlares: false
  })

  await setAnimations(true)
  const after = await measure()
  expect(after.siblingOpacity).not.toBe('1')
  expect(after.sheen).toBe('og-alive-sheen')
  expect(after.haloFlares).toBe(true)
})
