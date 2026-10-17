// Opens every app once as asha.rao so first-run side effects (Deck welcome board, calendar example event,
// contact upgrades, Text/Notes setup) land in the seed before snapshot.sh. xvfb-run -a node warmup.mjs
import { chromium } from 'playwright-core'
const app = (await import('../../apps/nextcloud.mjs')).default
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.launch({ channel: 'chrome', headless: false })
const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'en-IN', timezoneId: 'Asia/Kolkata' })
const page = await context.newPage()
await app.login({ page, sleep })
for (const p of ['/apps/files/files', '/apps/files/files?dir=/Projects', '/apps/calendar/', '/apps/contacts/', '/apps/deck/', '/apps/deck/board/2', '/apps/notes/', '/apps/files/files']) {
  await page.goto(app.origin + p).catch(() => {})
  await sleep(6000)
  console.log(p, await page.title())
}
await browser.close()
