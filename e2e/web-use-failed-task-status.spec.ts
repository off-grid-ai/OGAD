import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid } from './helpers/launch'

// The real built app with one Web Use run in its task history: it failed while the model was
// deciding its next step. Opening that task must show it as failed, not as still "Deciding the next
// step" — the last action is history once the task is over.

const TASK_ID = 'web-use-failed-while-deciding'

let app: ElectronApplication | null = null
let page: Page
let profileDir = ''

test.describe.configure({ timeout: 180_000 })

const sql = (value: string): string => `'${value.replaceAll("'", "''")}'`

function seedFailedTask(): void {
  const now = Date.now()
  execFileSync('sqlite3', [
    path.join(profileDir, 'memories.db'),
    `CREATE TABLE task_run_history (
      task_id TEXT PRIMARY KEY, journey_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL, summary TEXT, steps_json TEXT NOT NULL DEFAULT '[]',
      started_at INTEGER NOT NULL, finished_at INTEGER, updated_at INTEGER NOT NULL,
      execution_device_id TEXT, execution_device_name TEXT, phase TEXT, current_step INTEGER,
      current_action TEXT, last_url TEXT, last_title TEXT, screenshot_path TEXT,
      screenshot_device_id TEXT, step_details_json TEXT NOT NULL DEFAULT '[]'
    );
    INSERT INTO task_run_history VALUES (
      ${sql(TASK_ID)}, 'web-use-failed-journey', 'web_use', 'Open en.wikipedia.org and read the featured article',
      'failed', 'Web Use stopped: the decision model did not answer.',
      ${sql(JSON.stringify(['Opened en.wikipedia.org']))},
      ${now - 60_000}, ${now - 30_000}, ${now - 30_000},
      NULL, NULL, 'thinking', 2, 'Deciding the next step',
      'https://en.wikipedia.org/', 'Wikipedia', NULL, NULL, '[]'
    );`
  ])
}

test.beforeAll(async () => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-web-use-failed-'))
  seedFailedTask()
  app = await launchOffGrid({
    cwd: profileDir,
    env: {
      OFFGRID_USER_DATA: profileDir,
      OFFGRID_PRO: '1',
      OFFGRID_E2E_HEADLESS: '1',
      OFFGRID_E2E_ISOLATED_INSTANCE: '1'
    }
  })
  page = await app.firstWindow()
  page.on('pageerror', (error) => console.error(`[renderer error] ${error.stack ?? error.message}`))
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)
})

test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  fs.rmSync(profileDir, { recursive: true, force: true })
})

test('a Web Use task that failed mid-decision reads as failed, not as still deciding', async () => {
  await page.keyboard.press('Meta+K')
  const palette = page.getByRole('dialog', { name: 'Search Off Grid AI' })
  await expect(palette).toBeVisible()
  await palette.getByPlaceholder(/^Search everything/).fill('Chat')
  await page.getByTestId('palette-screen-memory-chat-root').click()
  await page
    .getByTestId('main-workspace')
    .getByRole('button', { name: /^Tasks(?:,|$)/ })
    .click()
  await expect(page.getByTestId('task-side-panel')).toBeVisible()
  await page.getByTestId(`task-tab-${TASK_ID}`).click()

  const header = page.getByTestId('task-live-controls')
  await expect(header).toContainText('failed')
  await expect(header).not.toContainText('Deciding the next step')
  await expect(header.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await page.screenshot({ path: 'e2e/screenshots/web-use-failed-task-status.png' })
})
