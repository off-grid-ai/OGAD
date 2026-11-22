// Click through OGAD onboarding once for the sandbox profile (picks skipped), so the app shell and
// its browser pane are on screen; a hidden pane cannot take screenshots. Same matchers as
// e2e/helpers/onboarding.ts.  Usage: node onboard.mjs [cdp-port]
import { homedir } from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(`${homedir()}/wednesday/off-grid-ai/desktop/package.json`)
const { chromium } = require('playwright')
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.argv[2] ?? 9333}`)
const page = browser
  .contexts()
  .flatMap((c) => c.pages())
  .find((p) => /localhost:\d+\/?$|index\.html/.test(p.url()))
if (!page) throw new Error('main window not found')
const cta = page
  .getByRole('button', { name: /^(Continue|Show me how it works|Set up my models|Start using Off Grid AI)/i })
  .first()
const skip = page.getByRole('button', { name: /^(Skip, set it up|Skip for now)$/i }).first()
let clicks = 0
for (let step = 0; step < 15; step += 1) {
  await page.waitForTimeout(800)
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {})
  else if (await cta.isVisible().catch(() => false)) await cta.click().catch(() => {})
  else break
  clicks += 1
}
const dismiss = page.getByRole('button', { name: 'Dismiss', exact: true })
if (await dismiss.isVisible().catch(() => false)) await dismiss.click().catch(() => {})
console.log(JSON.stringify({ clicks, onShell: !(await cta.isVisible().catch(() => false)) }))
await page.screenshot({ path: `${homedir()}/agent-sandbox/ogad/shots/after-onboarding.png` }).catch(() => {})
process.exit(0)
