import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// A fresh profile with two synthetic gateway requests: one sent with the API key "laptop", one
// with no key. The AI activity window names the key on the first and nothing extra on the second.
test('AI activity names the API key that sent a request', async ({ playwright }) => {
  test.setTimeout(120_000)
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-ai-activity-key-'))
  const quote = (value: unknown): string => `'${String(value).replaceAll("'", "''")}'`
  const rows = [
    { id: '00000000-0000-4000-8000-0000000000a1', keyName: 'laptop', preview: 'Keyed request' },
    { id: '00000000-0000-4000-8000-0000000000a2', preview: 'Open request' }
  ].map((row, index) => ({
    ...row,
    modality: 'text',
    source: 'API chat',
    model: 'Test model',
    backend: 'Metal',
    status: 'completed',
    startedAt: Date.now() - index * 1000,
    durationMs: 900,
    request: { messages: [{ role: 'user', content: row.preview }] },
    response: `${row.preview} answered`
  }))
  execFileSync('sqlite3', [
    path.join(profile, 'memories.db'),
    `
    CREATE TABLE ai_request_logs (id TEXT PRIMARY KEY, parent_id TEXT, started_at INTEGER NOT NULL,
      duration_ms INTEGER, modality TEXT NOT NULL, status TEXT NOT NULL, model TEXT, backend TEXT,
      search TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT NOT NULL, bytes INTEGER NOT NULL);
    ${rows
      .map(
        (row) => `INSERT INTO ai_request_logs VALUES (${quote(row.id)},NULL,${row.startedAt},900,
      'text','completed','Test model','Metal',${quote(row.preview)},
      ${quote(JSON.stringify(row))},${quote(JSON.stringify(row))},1000);`
      )
      .join('\n')}
  `
  ])
  const app = await playwright._electron.launch({
    args: [process.env.OFFGRID_AI_ACTIVITY_APP ?? '.'],
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profile,
      OFFGRID_E2E_ISOLATED_INSTANCE: '1',
      OFFGRID_E2E_HEADLESS: '1',
      OFFGRID_PRO: '0',
      OFFGRID_SEED: ''
    }
  })
  try {
    const main = await app.firstWindow()
    await main.waitForFunction(() => !!window.api?.aiLogsOpenWindow)
    const windowPromise = app.waitForEvent('window')
    await main.evaluate(() => window.api.aiLogsOpenWindow())
    const activity = await windowPromise
    const keyed = activity.getByRole('button', { name: /Keyed request/ })
    const open = activity.getByRole('button', { name: /Open request/ })
    await expect(keyed).toContainText('API chat · laptop')
    await expect(open).toContainText('API chat')
    await expect(open).not.toContainText('laptop')
    await keyed.click()
    await expect(activity.getByTitle('API key')).toHaveText('laptop')
    await activity.screenshot({
      path: 'e2e/screenshots/ai-activity-key.png',
      animations: 'disabled'
    })
  } finally {
    await app.close()
    fs.rmSync(profile, { recursive: true, force: true })
  }
})
