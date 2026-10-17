/**
 * Tidy up on a 0.0.54 profile: it shows what it will change, then moves automatic to-dos to
 * Suggested, keeps the one the person accepted, removes extra meeting copies, and is not offered
 * again.
 *
 * Real Tidy up prompt, rebuild plan and apply (pro/main/crm/rebuild.ts), and the Actions screen.
 * The boundary is the profile: to-dos and a meeting saved twice by 0.0.54 are written into it
 * between launches.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { launchOffGrid, targetIsPackaged, tidyUpDialog } from './helpers/launch'
import { completeOnboarding } from './helpers/onboarding'
import { closeAndWait } from './helpers/windows'

const PRO_PRESENT = fs.existsSync(path.resolve('pro/package.json'))
/** Before automatic to-dos started in Suggested (SUGGESTED_BY_DEFAULT_SINCE_MS). */
const SAVED_BY_0054 = 1_760_000_000_000

let app: ElectronApplication | null = null
let page: Page
let profileDir: string

const db = (): string => path.join(profileDir, 'memories.db')

const launch = async (keepLaunchOffers = false): Promise<void> => {
  app = await launchOffGrid({
    keepLaunchOffers,
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profileDir,
      OFFGRID_E2E_LICENSE_FIXTURE: path.join(profileDir, 'no-license'),
      OFFGRID_PRO: '1',
      OFFGRID_NO_SERVICES: '1',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await completeOnboarding(page)
}

const close = async (): Promise<void> => {
  await closeAndWait(app!)
  app = null
}

/** What 0.0.54 left: an automatic to-do, one the person accepted, and a meeting saved twice. */
function seed054History(): void {
  const history = new DatabaseSync(db())
  const todo = history.prepare(
    `INSERT INTO action_items (text, raw_text, source_app, status, created_at, accepted_at)
     VALUES (?, ?, 'Mail', 'open', ?, ?)`
  )
  todo.run('Send the Harbour invoice', 'Send the Harbour invoice', SAVED_BY_0054, null)
  todo.run('Book the offsite venue', 'Book the offsite venue', SAVED_BY_0054, SAVED_BY_0054 + 1)
  const meeting = history.prepare(
    `INSERT INTO observations (summary, surface, category, source_session_id, ts)
     VALUES ('Weekly sync with the design team', 'Meetings', 'communication', 'meeting:7', datetime('now'))`
  )
  meeting.run()
  meeting.run()
  history.close()
}

const meetingCopies = (): number => {
  const history = new DatabaseSync(db(), { readOnly: true })
  const { n } = history
    .prepare("SELECT COUNT(*) AS n FROM observations WHERE source_session_id = 'meeting:7'")
    .get() as { n: number }
  history.close()
  return n
}

const nav = (name: string): ReturnType<Page['getByRole']> =>
  page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name, exact: true })

const todosIn = async (status: string): Promise<ReturnType<Page['getByRole']>> => {
  await page
    .getByRole('radiogroup', { name: 'To-do status' })
    .getByRole('radio', { name: new RegExp(`^${status}`) })
    .click()
  return page.getByRole('list', { name: 'To-dos', exact: true })
}

test.describe('Tidy up', () => {
  test.skip(targetIsPackaged(), 'Source build with a seeded Pro profile')

  test.beforeEach(() => {
    test.skip(!PRO_PRESENT, 'pro package not present: Tidy up is a Pro surface')
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-tidy-up-'))
    // A 0.0.54 profile is plaintext, so the test can write its history.
    const seed = new DatabaseSync(db())
    seed.exec('CREATE TABLE e2e_seed (x INTEGER);')
    seed.close()
  })

  test.afterEach(async () => {
    if (app) await closeAndWait(app)
    app = null
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true })
  })

  test('previews, cleans, keeps the accepted to-do, and is not offered again', async () => {
    test.setTimeout(150_000)
    await launch()
    await close()
    seed054History()
    expect(meetingCopies()).toBe(2)

    await launch(true)
    const prompt = tidyUpDialog(page)
    await expect(prompt).toBeVisible({ timeout: 20_000 })
    await expect(prompt).toContainText('1 automatic to-dos wait in Suggested for you to accept.')
    await expect(prompt).toContainText('1 extra copies of re-transcribed meetings are removed')
    await prompt.getByRole('button', { name: 'Tidy up', exact: true }).click()
    await expect(prompt).toBeHidden({ timeout: 30_000 })

    await nav('Actions').click()
    await expect((await todosIn('suggested')).getByText('Send the Harbour invoice')).toBeVisible()
    const open = await todosIn('open')
    await expect(open.getByText('Book the offsite venue')).toBeVisible()
    await expect(open.getByText('Send the Harbour invoice')).toHaveCount(0)
    await close()
    expect(meetingCopies()).toBe(1)

    // Once tidied, the offer does not come back.
    await launch(true)
    await nav('Actions').click()
    await expect((await todosIn('open')).getByText('Book the offsite venue')).toBeVisible()
    expect(await page.evaluate(() => window.api.proInvoke('crm:rebuild-plan'))).toBeNull()
    await expect(tidyUpDialog(page)).toHaveCount(0)
  })
})
