/**
 * Only people with evidence are listed; the rest wait under Suggested until the person confirms.
 *
 * Real Entities screen, evidence rule (pro/main/crm/evidence.ts) and Confirm. The boundary is the
 * captured history: observations are written into the profile between launches. Avery appears
 * only in bulk mail and in an inbox list naming five people, which is not evidence. Bea is in
 * conversations on two days, which is.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import { completeOnboarding } from './helpers/onboarding'
import { closeAndWait } from './helpers/windows'

const PRO_PRESENT = fs.existsSync(path.resolve('pro/package.json'))

let app: ElectronApplication | null = null
let page: Page
let profileDir: string

const db = (): string => path.join(profileDir, 'memories.db')

const launch = async (): Promise<void> => {
  app = await launchOffGrid({
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

const relaunch = async (): Promise<void> => {
  await closeAndWait(app!)
  app = null
  await launch()
}

/** What capture saw over two days. */
function seedHistory(): void {
  const history = new DatabaseSync(db())
  history.exec(
    `INSERT INTO entities (name, type) VALUES
       ('Avery Quinn', 'Person'), ('Bea Moreno', 'Person'),
       ('Cal Ortiz', 'Person'), ('Dana Lee', 'Person'), ('Eli Park', 'Person');
     INSERT INTO observations (summary, surface, category, engagement, ts) VALUES
       ('Read the Avery Quinn newsletter', 'Mail', 'consumption', 0.5, datetime('now', '-1 day')),
       ('Skimmed another Avery Quinn digest', 'Mail', 'consumption', 0.5, datetime('now')),
       ('Scrolled the inbox list', 'Mail', 'communication', 0.5, datetime('now')),
       ('Talked through the launch with Bea Moreno', 'Slack', 'communication', 0.5, datetime('now', '-1 day')),
       ('Agreed the budget with Bea Moreno', 'Slack', 'communication', 0.5, datetime('now'));
     INSERT INTO observation_entities (observation_id, entity_id)
       SELECT o.id, e.id FROM observations o JOIN entities e
        WHERE (o.summary LIKE '%Avery Quinn%' AND e.name = 'Avery Quinn')
           OR (o.summary LIKE '%Bea Moreno%' AND e.name = 'Bea Moreno')
           OR (o.summary = 'Scrolled the inbox list'
               AND e.name IN ('Avery Quinn', 'Cal Ortiz', 'Dana Lee', 'Eli Park', 'Bea Moreno'));`
  )
  history.close()
}

const nav = (name: string): ReturnType<Page['getByRole']> =>
  page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name, exact: true })

const people = (): ReturnType<Page['getByRole']> =>
  page.getByRole('list', { name: 'Person entities' })

test.describe('People with evidence', () => {
  test.skip(targetIsPackaged(), 'Source build with a seeded Pro profile')

  test.beforeEach(() => {
    test.skip(!PRO_PRESENT, 'pro package not present: Entities is a Pro surface')
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-entities-evidence-'))
    // A profile from before encryption stays plaintext, so the test can write history into it.
    const seed = new DatabaseSync(db())
    seed.exec('CREATE TABLE e2e_seed (x INTEGER);')
    seed.close()
  })

  test.afterEach(async () => {
    if (app) await closeAndWait(app)
    app = null
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true })
  })

  test('Entities lists Bea, not Avery; Avery is Suggested and stays listed once confirmed', async () => {
    test.setTimeout(120_000)
    await launch()
    await closeAndWait(app!)
    app = null
    seedHistory()
    await launch()

    await nav('Entities').click()
    await expect(people().getByRole('button', { name: 'Open Bea Moreno' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open Avery Quinn' })).toHaveCount(0)

    const suggested = page.getByRole('button', { name: /^Suggested \(\d+\)$/ })
    await suggested.click()
    await expect(suggested).toHaveAttribute('aria-pressed', 'true')
    const avery = people().getByRole('listitem').filter({ hasText: 'Avery Quinn' })
    await expect(avery).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open Bea Moreno' })).toHaveCount(0)
    await avery.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Open Avery Quinn' })).toHaveCount(0)

    await relaunch()
    await nav('Entities').click()
    await expect(people().getByRole('button', { name: 'Open Avery Quinn' })).toBeVisible()
    await expect(people().getByRole('button', { name: 'Open Bea Moreno' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open Cal Ortiz' })).toHaveCount(0)
  })
})
