// Connect OGAD's email connection to the sandbox test mailbox (IMAP, alex@offgrid-mail.test), so
// the web agent can read the sign-in codes the bank and airline email. Idempotent.
// Usage: node connect-mail.mjs <cdp-port>   (reads ~/agent-sandbox/.env; prints no secrets)
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(`${homedir()}/wednesday/off-grid-ai/desktop/package.json`)
const { chromium } = require('playwright')

const env = Object.fromEntries(
  readFileSync(`${homedir()}/agent-sandbox/.env`, 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
)
const NAME = 'Sandbox mail (IMAP)'

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.argv[2] ?? 9333}`)
let page
for (let i = 0; i < 120 && !page; i++) {
  for (const p of browser.contexts().flatMap((c) => c.pages())) {
    if (!/localhost:\d+\/?$|index\.html/.test(p.url())) continue
    if (await p.evaluate(() => typeof window.api?.mcpAdd === 'function').catch(() => false)) page = p
  }
  if (!page) await new Promise((r) => setTimeout(r, 500))
}
if (!page) throw new Error('main window not found')

const result = await page.evaluate(
  async ({ name, password }) => {
    const api = window.api
    const existing = ((await api.mcpList()) ?? []).find((c) => c.name === name)
    const id =
      existing?.id ??
      (await api.mcpAdd({
        name,
        transport: 'http',
        url: 'imap://',
        envKeys: ['IMAP_SERVER', 'IMAP_USER', 'IMAP_PASSWORD']
      }))
    await api.mcpSetSecrets(id, {
      IMAP_SERVER: 'imap://127.0.0.1:1143',
      IMAP_USER: 'alex@offgrid-mail.test',
      IMAP_PASSWORD: password
    })
    if (existing && !existing.enabled) await api.mcpSetEnabled(id, true)
    const test = await api.mcpTest(id)
    return { id, created: !existing, ok: test?.ok, tools: test?.tools?.map((t) => t.name), error: test?.error }
  },
  { name: NAME, password: env.MAIL_PASSWORD }
)
console.log(JSON.stringify(result))
await browser.close()
