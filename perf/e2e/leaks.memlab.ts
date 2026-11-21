/**
 * Heap snapshots for the memlab leak check (npm run perf:leaks, which runs this and then
 * perf/memlab/run.mjs analyses the three files). The journey: from Chat, open Settings and go back,
 * three times. memlab reports objects that Settings created (in the target snapshot) and that are
 * still held after leaving it (in the final snapshot): a screen that leaks on every visit.
 */
import {
  expect,
  test,
  type CDPSession,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchOffGrid } from '../../e2e/helpers/launch'
import { completeOnboarding } from '../../e2e/helpers/onboarding'
import { gotoSettings, navButton } from '../../e2e/helpers/settings'

const snapshotDir =
  process.env.PERF_SNAPSHOTS ?? path.join(process.cwd(), 'perf', 'results', 'snapshots')

let userDataDir: string
let app: ElectronApplication
let page: Page

const snapshot = async (cdp: CDPSession, name: string): Promise<void> => {
  // Settle animations and let React drop what it unmounted, then collect, as memlab does.
  await page.waitForTimeout(2_000)
  await cdp.send('HeapProfiler.collectGarbage')
  await cdp.send('HeapProfiler.collectGarbage')
  const file = path.join(snapshotDir, `${name}.heapsnapshot`)
  const out = fs.createWriteStream(file)
  const onChunk = ({ chunk }: { chunk: string }): void => {
    out.write(chunk)
  }
  cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk)
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
  cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk)
  await new Promise<void>((resolve) => out.end(resolve))
}

test.beforeAll(async () => {
  fs.rmSync(snapshotDir, { recursive: true, force: true })
  fs.mkdirSync(snapshotDir, { recursive: true })
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-memlab-'))
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_PRO: '1',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await completeOnboarding(page)
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

test('Settings, visited three times, leaves nothing behind', async () => {
  const toChat = async (): Promise<void> => {
    await navButton(page, 'Chat').click()
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible()
  }
  const dismiss = page.getByRole('button', { name: 'Dismiss', exact: true })
  await toChat()
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click()

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('HeapProfiler.enable')
  // One visit first, so lazy chunks and caches that load once are in the baseline, not a "leak".
  await gotoSettings(page)
  await toChat()
  await snapshot(cdp, 'baseline')

  for (let i = 0; i < 3; i++) {
    await gotoSettings(page)
    if (i < 2) await toChat()
  }
  await snapshot(cdp, 'target')

  await toChat()
  await snapshot(cdp, 'final')
  await cdp.detach()
})
