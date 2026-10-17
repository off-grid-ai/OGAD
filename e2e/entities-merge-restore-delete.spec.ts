/**
 * Merge, restore and delete in Entities hold after a relaunch, and a deleted person is not
 * brought back by a new mention.
 *
 * Real Entities screen, dossier, merge, archive and delete, and the real connector ingest that
 * turns a connector's items into entities. The boundaries: the captured history, written into
 * the profile between launches, and a local MCP server whose notes mention the deleted person.
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
const NOTES_SERVER = path.resolve('e2e/fixtures/team-notes-mcp-connector.mjs')
const PEOPLE = ['Maya Chen', 'Xavier Stone', 'Yara Holt', 'Zoe Archer']

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

/** Each person in conversations on two days; Zoe was archived earlier. */
function seedPeople(): void {
  const history = new DatabaseSync(db())
  for (const name of PEOPLE) {
    history.prepare("INSERT INTO entities (name, type) VALUES (?, 'Person')").run(name)
    for (const when of ['-1 day', '+0 day']) {
      const { lastInsertRowid } = history
        .prepare(
          `INSERT INTO observations (summary, surface, category, engagement, ts)
           VALUES (?, 'Slack', 'communication', 0.5, datetime('now', ?))`
        )
        .run(`Planned the launch with ${name}`, when)
      history
        .prepare(
          'INSERT INTO observation_entities (observation_id, entity_id) SELECT ?, id FROM entities WHERE name = ?'
        )
        .run(lastInsertRowid, name)
    }
  }
  history.prepare("UPDATE entities SET hidden = 1 WHERE name = 'Zoe Archer'").run()
  history.close()
}

const entityNames = async (): Promise<string[]> =>
  (
    (await page.evaluate(() => window.api.crmListEntities())) as Array<{
      name: string
      hidden?: number
    }>
  ).map(({ name }) => name)

const nav = (name: string): ReturnType<Page['getByRole']> =>
  page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name, exact: true })

const row = (name: string): ReturnType<Page['getByRole']> =>
  page
    .getByRole('list', { name: 'Person entities' })
    .getByRole('listitem')
    .filter({
      has: page.getByRole('button', { name: `Open ${name}` })
    })

test.describe('Entities merge, restore and delete', () => {
  test.skip(targetIsPackaged(), 'Source build with a seeded Pro profile')

  test.beforeEach(() => {
    test.skip(!PRO_PRESENT, 'pro package not present: Entities is a Pro surface')
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-entities-edit-'))
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

  test('the changes survive a relaunch, and a new mention does not bring back a deleted person', async () => {
    test.setTimeout(180_000)
    await launch()
    await closeAndWait(app!)
    app = null
    seedPeople()
    await launch()
    await nav('Entities').click()

    // Merge Maya into Xavier.
    await row('Maya Chen').getByRole('button', { name: 'Merge into another entity' }).click()
    const merge = page.getByRole('dialog', { name: /Merge Maya Chen into/ })
    await merge.getByPlaceholder('Search the survivor entity…').fill('Xavier')
    await merge.getByRole('button', { name: /^Xavier Stone/ }).click()
    await expect(page.getByRole('button', { name: 'Open Maya Chen' })).toHaveCount(0)
    // The survivor's dossier opens.
    await expect(page.getByRole('article', { name: 'Xavier Stone dossier' })).toBeVisible()
    await page.getByRole('button', { name: 'Back to entities' }).click()

    // Restore Zoe from the archive.
    await page.getByRole('button', { name: 'Show archived (1)' }).click()
    await row('Zoe Archer').getByRole('button', { name: 'Unhide' }).click()
    await expect(page.getByText('No archived entities.')).toBeVisible()
    await page.getByRole('button', { name: 'Hide archived' }).click()
    await expect(row('Zoe Archer')).toBeVisible()

    // Delete Yara from her dossier, after confirming.
    await page.getByRole('button', { name: 'Open Yara Holt' }).click()
    const dossier = page.getByRole('article', { name: 'Yara Holt dossier' })
    await dossier.getByRole('button', { name: 'Delete', exact: true }).click()
    await dossier
      .getByRole('group', { name: 'Delete Yara Holt?' })
      .getByRole('button', { name: 'Delete', exact: true })
      .click()
    await expect(page.getByRole('button', { name: 'Open Yara Holt' })).toHaveCount(0)

    await relaunch()
    await nav('Entities').click()
    await expect(row('Xavier Stone')).toBeVisible()
    await expect(row('Zoe Archer')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open Maya Chen' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Open Yara Holt' })).toHaveCount(0)

    // A connector's notes mention Yara again: the other note becomes an entity, Yara does not.
    const ingested = await page.evaluate(
      async ([command, server]) => {
        const id = (await window.api.mcpAdd({
          name: 'Team notes',
          transport: 'stdio',
          command,
          args: [server]
        })) as number
        return window.api.mcpIngest(id)
      },
      [process.execPath, NOTES_SERVER]
    )
    expect(ingested).toEqual({ ok: true, count: 2 })
    const names = await entityNames()
    expect(names).toContain('Orbit roadmap')
    expect(names).not.toContain('Yara Holt')
    expect(names).not.toContain('Maya Chen')
  })
})
