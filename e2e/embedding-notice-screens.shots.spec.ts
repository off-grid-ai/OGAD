/**
 * Light-mode screens of the embedding rebuild notice, for the PR.
 *
 * It exists for the design-token pass: EmbeddingRebuildNotice moved from hand-typed sizes and
 * palette colours to the @offgrid/design tokens. The same spec runs on the branch point and on the
 * change, so the pair is comparable.
 *
 * Nothing is faked: each status arrives on its real channel from main.
 *
 * Run from the desktop root (it only runs when VIDEO_SHOTS is set, so the e2e suite skips it):
 *   npm run shots -- embedding before
 *   npm run shots -- embedding after
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EmbeddingRebuildStatus } from '../src/shared/embedding-rebuild-contract'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import { completeOnboarding } from './helpers/onboarding'

test.describe.configure({ mode: 'serial' })

const PHASE = process.env.VIDEO_SHOTS === 'after' ? 'after' : 'before'
/** Light by default; VIDEO_SHOTS_THEME=dark checks the dark theme, into `-dark` files. */
const THEME = process.env.VIDEO_SHOTS_THEME === 'dark' ? 'dark' : 'light'
const SHOTS = path.resolve('docs/pr-screenshots/release/analytics-video')
const MODEL = 'nomic-ai/nomic-embed-text-v1.5'

let app: ElectronApplication | null = null
let page: Page
let profileDir: string

const send = async (status: EmbeddingRebuildStatus): Promise<void> => {
  await app!.evaluate(({ BrowserWindow }, next) => {
    for (const win of BrowserWindow.getAllWindows())
      win.webContents.send('models:embedding-rebuild-status-changed', next)
  }, status)
}

const shot = async (name: string): Promise<void> => {
  await page.waitForTimeout(500) // let entry motion settle, so before/after differ only in tokens
  await page.screenshot({
    path: path.join(
      SHOTS,
      `embedding-notice-${name}-${PHASE}${THEME === 'dark' ? '-dark' : ''}.png`
    )
  })
}

test.beforeAll(async () => {
  test.skip(!process.env.VIDEO_SHOTS, 'PR screens only: npm run shots -- embedding <phase>')
  test.skip(targetIsPackaged(), 'The screens come from the source build')
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-embedding-shots-'))
  fs.mkdirSync(SHOTS, { recursive: true })
  app = await launchOffGrid({
    env: { ...process.env, OFFGRID_USER_DATA: profileDir, NODE_ENV: 'production' }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate((theme) => window.ogTheme.set(theme), THEME)
  await completeOnboarding(page)
})

test.afterAll(async () => {
  if (app) {
    const child = app.process()
    await app.close()
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve))
  }
  if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true })
})

test('Rebuilding, restored and failed', async () => {
  await send({ phase: 'rebuilding', model: MODEL, done: 412, total: 1280 })
  await expect(page.getByRole('button', { name: 'Cancel and restore' })).toBeVisible()
  await shot('rebuilding')

  await send({ phase: 'restored', model: MODEL, done: 0, total: 0 })
  await expect(page.getByText('Previous embedding model and search index restored.')).toBeVisible()
  await shot('restored')

  await send({ phase: 'error', model: MODEL, done: 0, total: 0, error: 'Embedding failed' })
  await expect(page.getByText(/Search index rebuild failed/)).toBeVisible()
  await shot('error')
})
