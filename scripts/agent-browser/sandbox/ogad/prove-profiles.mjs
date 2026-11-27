// For each sandbox profile: open it in OGAD's own sandbox partition (window.api.browser), check the
// https page loads, let the Vault fill the login, sign in, and report. Prints no secrets.
// Usage: node prove-profiles.mjs [cdp-port] [profile...]
import { homedir } from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(`${homedir()}/wednesday/off-grid-ai/desktop/package.json`)
const { chromium } = require('playwright')
const port = process.argv[2] ?? '9333'
const only = process.argv.slice(3)
const SHOTS = `${homedir()}/agent-sandbox/ogad/shots`

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const pages = () => browser.contexts().flatMap((c) => c.pages())
const app = pages().find((p) => /localhost:\d+\/?$|index\.html/.test(p.url()))
if (!app) throw new Error('main window not found')

const profiles = await app.evaluate(() => window.api.browser.sandboxProfiles())
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const report = []
for (const profile of profiles) {
  if (only.length && !only.includes(profile.id)) continue
  const row = { profile: profile.id }
  const opened = await app.evaluate((id) => window.api.browser.openSandboxProfile(id), profile.id)
  row.session = Boolean(opened?.sessionId)
  await wait(5000)
  const host = new URL(
    { mail: 'https://offgrid-mail.test/', calendar: 'https://offgrid-cloud.test/' }[profile.id] ??
      `https://offgrid-${profile.id === 'airline' ? 'air' : profile.id}.test/`
  ).host
  const page = pages().find((p) => p.url().includes(host))
  row.loaded = page ? page.url() : null
  const vault = await app.evaluate((s) => window.api.browser.vaultState(s), opened?.sessionId)
  row.vault = `${vault.state}${vault.logins ? ` (${vault.logins.length} login)` : ''}`
  if (vault.state === 'available' && vault.logins.length === 1 && page) {
    const fill = await app.evaluate(
      ({ s, u }) => window.api.browser.fillLogin(s, u),
      { s: opened.sessionId, u: vault.logins[0].uuid }
    )
    row.fill = fill.ok ? `filled as ${fill.username}` : JSON.stringify(fill)
    const pw = page.locator('input[type=password]').first()
    row.passwordFieldFilled = (await pw.inputValue().catch(() => '')).length > 0
    await pw.press('Enter').catch(() => {})
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {})
    await wait(3000)
    row.afterSignIn = page.url()
    row.stillOnLogin = (await page.locator('input[type=password]').count()) > 0
    await page.screenshot({ path: `${SHOTS}/${profile.id}-signed-in.png`, timeout: 5000 }).catch(() => {})
  }
  report.push(row)
  console.log(JSON.stringify(row))
}
await browser.close()
