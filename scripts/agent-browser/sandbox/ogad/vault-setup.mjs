// Create (or unlock) the sandbox dev profile's Vault and save one login per sandbox site.
// Usage: node vault-setup.mjs <cdp-port>   (reads ~/agent-sandbox/.env; prints no secrets)
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
const LOGINS = [
  { title: 'Sandbox mail', url: 'https://offgrid-mail.test/', username: 'alex@offgrid-mail.test', key: 'MAIL_PASSWORD' },
  { title: 'Sandbox cloud', url: 'https://offgrid-cloud.test/', username: 'alex', key: 'CLOUD_PASSWORD' },
  { title: 'Sandbox shop', url: 'https://offgrid-shop.test/', username: 'alex', key: 'SHOP_PASSWORD' },
  { title: 'Sandbox airline', url: 'https://offgrid-air.test/', username: 'alex', key: 'AIR_PASSWORD' },
  { title: 'Sandbox bank', url: 'https://offgrid-bank.test/', username: 'alex', key: 'BANK_PASSWORD' },
  { title: 'Sandbox forms', url: 'https://offgrid-forms.test/', username: 'alex', key: 'FORMS_PASSWORD' }
]

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.argv[2] ?? 9333}`)
const page = browser
  .contexts()
  .flatMap((c) => c.pages())
  .find((p) => !p.url().startsWith('devtools') && /index\.html|localhost:\d+\/?$|\/#/.test(p.url()))
if (!page) throw new Error('main window not found')

const result = await page.evaluate(
  async ({ logins, master }) => {
    const api = window.api
    const status = await api.proInvoke('vault:status')
    let opened
    if (status?.status === 'not_initialized') {
      opened = await api.proInvoke('vault:init', master)
    } else if (status?.status === 'locked') {
      opened = await api.proInvoke('vault:unlock', master)
    }
    const list = await api.proInvoke('vault:entries:list')
    const have = new Set((list.entries ?? []).map((e) => e.url))
    const added = []
    for (const l of logins) {
      if (have.has(l.url)) continue
      const r = await api.proInvoke('vault:entries:add', {
        title: l.title,
        url: l.url,
        username: l.username,
        password: l.password,
        type: 'login'
      })
      added.push({ title: l.title, ok: r?.ok })
    }
    const after = await api.proInvoke('vault:entries:list')
    return {
      status: JSON.stringify(status).slice(0, 200),
      opened: JSON.stringify(opened).slice(0, 200),
      added,
      entries: (after.entries ?? []).map((e) => `${e.title} ${e.url} ${e.username}`)
    }
  },
  { logins: LOGINS.map((l) => ({ ...l, password: env[l.key] })), master: env.VAULT_PASSWORD }
)
console.log(JSON.stringify(result, null, 2))
await browser.close()
