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
import {
  linkObservationEntity,
  writeObservation
} from '../src/main/__tests__/harness/capture-fixtures'
import { registerFtsFunctions } from '../src/main/fts-functions'

const sqliteTime = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')

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
  // The app's index triggers call these functions; every writing connection registers them.
  registerFtsFunctions(history)
  const person: Record<string, number> = {}
  for (const name of ['Avery Quinn', 'Bea Moreno', 'Cal Ortiz', 'Dana Lee', 'Eli Park'])
    person[name] = Number(
      history.prepare("INSERT INTO entities (name, type) VALUES (?, 'Person')").run(name)
        .lastInsertRowid
    )
  // Observations as Pro's capture writes them (the shared capture fixtures), with who was in them.
  const DAY = 86_400_000
  const seen: Array<[string, string, string, number, string[]]> = [
    ['Read the Avery Quinn newsletter', 'Mail', 'consumption', DAY, ['Avery Quinn']],
    ['Skimmed another Avery Quinn digest', 'Mail', 'consumption', 0, ['Avery Quinn']],
    [
      'Scrolled the inbox list',
      'Mail',
      'communication',
      0,
      ['Avery Quinn', 'Cal Ortiz', 'Dana Lee', 'Eli Park', 'Bea Moreno']
    ],
    ['Talked through the launch with Bea Moreno', 'Slack', 'communication', DAY, ['Bea Moreno']],
    ['Agreed the budget with Bea Moreno', 'Slack', 'communication', 0, ['Bea Moreno']]
  ]
  for (const [summary, surface, category, ago, names] of seen) {
    const observation = writeObservation(history, {
      summary,
      surface,
      category,
      engagement: 0.5,
      ts: sqliteTime(Date.now() - ago)
    })
    for (const name of names) linkObservationEntity(history, observation, person[name]!)
  }
  history.close()
}

const nav = (name: string): ReturnType<Page['getByRole']> =>
  page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name, exact: true })

const people = (): ReturnType<Page['getByRole']> =>
  page.getByRole('table', { name: 'Person entities' })

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
    const avery = people().getByRole('row').filter({ hasText: 'Avery Quinn' })
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
