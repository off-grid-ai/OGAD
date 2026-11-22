/**
 * The built-in browser does what an everyday browser does.
 *
 * Real app, real Electron pages; the boundary is a local web server.
 *
 * Asserts: a visited page is in searchable history; the star bookmarks it; find counts matches;
 * a page's pop-up opens as a tab and can still talk to its opener; a download lands in the
 * Downloads folder without overwriting; developer tools open; the library panel shows history;
 * and after a restart the open tabs, history and bookmarks are all still there.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import { closeAndWait, gotoScreen, mainWindow } from './helpers/windows'

const PRO_PRESENT = fs.existsSync(path.resolve('pro/package.json'))

let app: ElectronApplication | null = null
let page: Page
let profileDir = ''
let downloadsDir = ''
let server: http.Server | null = null
let origin = ''

test.describe.configure({ timeout: 240_000 })

const pages: Record<string, string> = {
  '/alpha': `<!doctype html><title>Alpha harbour page</title>
    <h1>Alpha</h1><p>needle one, needle two, needle three</p>
    <script>window.reply = '';
      window.addEventListener('message', (event) => { window.reply = String(event.data) })</script>`,
  '/beta': `<!doctype html><title>Beta page</title><h1>Beta</h1>
    <script>if (window.opener) window.opener.postMessage('beta says hello', '*')</script>`
}

async function startServer(): Promise<void> {
  server = http.createServer((request, response) => {
    if (request.url === '/report.txt') {
      response.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Disposition': 'attachment; filename="report.txt"'
      })
      response.end('quarterly numbers')
      return
    }
    const body = pages[request.url ?? '']
    response.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html' })
    response.end(body ?? 'not found')
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}

async function launch(): Promise<void> {
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profileDir,
      OFFGRID_PRO: '1',
      NODE_ENV: 'production',
      NO_PROXY: '127.0.0.1,localhost'
    }
  })
  page = await mainWindow(app)
  await app.evaluate(
    ({ app: electronApp }, dir) => electronApp.setPath('downloads', dir),
    downloadsDir
  )
}

/** The open tabs, as the browser reports them. */
const sessions = async (): Promise<Array<{ sessionId: string; url: string; title: string }>> =>
  page.evaluate(async () => {
    const snapshot = await window.api.browser.getSessions()
    return snapshot.sessions.map((s) => ({ sessionId: s.sessionId, url: s.url, title: s.title }))
  })

const activeId = async (): Promise<string> =>
  page.evaluate(async () => (await window.api.browser.getSessions()).activeSessionId ?? '')

/** Runs script in the page whose address ends with `suffix`. */
const inPage = async <T>(suffix: string, script: string): Promise<T> =>
  app!.evaluate(
    async ({ webContents }, args) => {
      const target = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().endsWith(args.suffix))
      if (!target) throw new Error(`no page at ${args.suffix}`)
      return target.executeJavaScript(args.script)
    },
    { suffix, script }
  ) as Promise<T>

test.beforeAll(async () => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-browser-everyday-'))
  downloadsDir = path.join(profileDir, 'Downloads')
  fs.mkdirSync(downloadsDir, { recursive: true })
  fs.writeFileSync(path.join(downloadsDir, 'report.txt'), 'an older file with the same name')
  await startServer()
})

test.afterAll(async () => {
  if (app) await closeAndWait(app)
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve())
  fs.rmSync(profileDir, { recursive: true, force: true })
})

test('history, bookmarks, find, pop-ups, downloads, developer tools, and a restart', async ({
  browserName: _browserName
}, testInfo) => {
  test.skip(targetIsPackaged(), 'Uses the source-built app.')
  test.skip(!PRO_PRESENT, 'pro package not present: the browser workspace is a Pro surface')
  await launch()
  await completeOnboarding(page)

  // Open the browser workspace and a page.
  await gotoScreen(page, 'Chat')
  await page
    .getByTestId('main-workspace')
    .getByRole('button', { name: /^Tasks(?:,|$)/ })
    .click()
  await page.evaluate((url) => window.api.browser.openUrl(url), `${origin}/alpha`)
  await expect
    .poll(async () => (await sessions()).map((s) => s.title))
    .toContain('Alpha harbour page')
  const alpha = await activeId()

  // The right-click menu library is attached to the page (it loads on first use).
  await expect
    .poll(() =>
      app!.evaluate(({ webContents }, url) => {
        const target = webContents.getAllWebContents().find((c) => c.getURL() === url)
        return target ? target.listenerCount('context-menu') : 0
      }, `${origin}/alpha`)
    )
    .toBeGreaterThan(0)

  // History: found by words in the title.
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.api.browser.searchHistory('harbour alpha'))).map(
        (v) => v.url
      )
    )
    .toEqual([`${origin}/alpha`])

  // Bookmark the page.
  expect(await page.evaluate((id) => window.api.browser.toggleBookmark(id), alpha)).toBe(true)
  expect((await page.evaluate(() => window.api.browser.listBookmarks())).map((b) => b.url)).toEqual(
    [`${origin}/alpha`]
  )

  // Find on page counts the matches.
  const found = await page.evaluate(
    (id) =>
      new Promise<number>((resolve) => {
        const stop = window.api.browser.onFindResult((result) => {
          if (result.sessionId === id && result.matches > 0) {
            stop()
            resolve(result.matches)
          }
        })
        void window.api.browser.find(id, 'needle')
      }),
    alpha
  )
  expect(found).toBe(3)
  await page.evaluate((id) => window.api.browser.stopFind(id), alpha)

  // A pop-up opens as a tab and keeps its opener (sign-in pop-ups rely on this).
  await inPage(`/alpha`, `window.open('/beta', '_blank', 'width=400,height=400'); true`)
  await expect.poll(async () => (await sessions()).map((s) => s.url)).toContain(`${origin}/beta`)
  await expect.poll(() => inPage<string>('/alpha', 'window.reply')).toBe('beta says hello')

  // A download lands in Downloads under a new name; the old file is untouched.
  await page.evaluate((id) => window.api.browser.activateSession(id), alpha)
  await page.evaluate(
    ([url, id]) => window.api.browser.navigate(url!, id!),
    [`${origin}/report.txt`, alpha]
  )
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.api.browser.listDownloads())).map((d) => d.state)
    )
    .toEqual(['completed'])
  expect(fs.readFileSync(path.join(downloadsDir, 'report (1).txt'), 'utf8')).toBe(
    'quarterly numbers'
  )
  expect(fs.readFileSync(path.join(downloadsDir, 'report.txt'), 'utf8')).toBe(
    'an older file with the same name'
  )

  // Developer tools open for the page.
  await page.evaluate((id) => window.api.browser.control('devtools', id), alpha)
  await expect
    .poll(() =>
      app!.evaluate(
        ({ webContents }, url) =>
          webContents
            .getAllWebContents()
            .some((contents) => contents.getURL() === url && contents.isDevToolsOpened()),
        `${origin}/alpha`
      )
    )
    .toBe(true)

  // The library panel lists the history.
  await page.getByRole('button', { name: 'History, bookmarks and downloads' }).last().click()
  const library = page.getByLabel('Browser library')
  await expect(library).toBeVisible()
  await expect(library.getByText('Alpha harbour page').first()).toBeVisible()
  await library.getByRole('tab', { name: 'Downloads' }).click()
  await expect(library.getByText('report (1).txt')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('browser-library-panel.png') })

  // Restart: tabs, history and bookmarks come back.
  await closeAndWait(app!)
  app = null
  await launch()
  await expect
    .poll(async () => (await sessions()).map((s) => s.url).sort(), { timeout: 30_000 })
    .toEqual([`${origin}/alpha`, `${origin}/beta`].sort())
  expect((await page.evaluate(() => window.api.browser.listBookmarks())).map((b) => b.url)).toEqual(
    [`${origin}/alpha`]
  )
  expect(
    (await page.evaluate(() => window.api.browser.searchHistory('beta'))).map((v) => v.url)
  ).toContain(`${origin}/beta`)
})
