// Authoring aid: log in to a clone app and print the Playwright MCP snapshot (OGAD's AX format)
// of a page, optionally after a few scripted actions. No rows are written.
//
//   xvfb-run -a node clones/probe.mjs --app roundcube --path '/?_task=mail' [--do 'click:button:Compose'] [--do 'type:textbox:Subject:Hello'] [--grep regex]
// --do forms: click:<role>:<name> | clickv:<role>:<value> | type:<role>:<name>:<text> | press:<key> | eval:<js>. A name in /slashes/ is a RegExp.

import { chromium } from 'playwright-core'
import { createConnection } from '@playwright/mcp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { parseTree, findTargets } from './tree.mjs'

const argv = process.argv.slice(2)
const opt = (k) => { const i = argv.indexOf(`--${k}`); return i < 0 ? undefined : argv[i + 1] }
const dos = argv.flatMap((v, i) => (v === '--do' ? [argv[i + 1]] : []))
const app = (await import(`./apps/${opt('app')}.mjs`)).default
const port = 9790 + Number(opt('port') ?? 0)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: [`--remote-debugging-port=${port}`] })
const context = await browser.newContext({ viewport: { width: 1366, height: 768 } })
const page = await context.newPage()
const server = await createConnection({ browser: { browserName: 'chromium', cdpEndpoint: `http://127.0.0.1:${port}` }, capabilities: ['core', 'core-navigation', 'core-tabs', 'core-input'], imageResponses: 'omit', snapshot: { mode: 'none', boxes: false }, timeouts: { action: 10_000, navigation: 45_000, settle: 350 } })
const client = new Client({ name: 'probe', version: '1' })
const [ct, st] = InMemoryTransport.createLinkedPair()
await Promise.all([server.connect(st), client.connect(ct)])
const tool = async (name, a) => { const r = await client.callTool({ name, arguments: a }); const text = (r.content ?? []).map((p) => p.text ?? '').join('\n'); return { text, isError: Boolean(r.isError) } }
const snap = async () => (await tool('browser_snapshot', { boxes: false })).text
const nameOf = (s) => (s?.startsWith('/') && s.endsWith('/') ? new RegExp(s.slice(1, -1)) : s)

if (!argv.includes('--no-login')) await app.login({ page, tool, sleep, sh: () => '' })
if (opt('path')) { await tool('browser_navigate', { url: new URL(opt('path'), app.origin).href }); await sleep(2000) }
for (const d of dos) {
  const [kind, role, name, ...rest] = d.split(':')
  if (kind === 'press') { await tool('browser_press_key', { key: role }); await sleep(1500); continue }
  if (kind === 'eval') { console.log(await page.evaluate(d.slice(5))); continue }
  // clickv / typev: match the text after the ref (value) instead of the name.
  const byValue = kind.endsWith('v')
  const found = findTargets(parseTree(await snap()), byValue ? { role, value: nameOf(name) } : { role, name: nameOf(name) })
  if (!found.length) { console.log(`!! not found: ${d}`); break }
  const r = kind.startsWith('click') ? await tool('browser_click', { element: name, target: found[0].ref }) : await tool('browser_type', { element: name, target: found[0].ref, text: rest.join(':'), submit: false })
  if (r.isError) console.log(`!! ${d}: ${r.text.slice(0, 300)}`)
  await sleep(1500)
}
let out = await snap()
if (opt('grep')) {
  const needle = opt('grep').toLowerCase()
  out = out.split('\n').filter((l) => l.toLowerCase().includes(needle)).join('\n')
}
console.log(out.slice(0, Number(opt('max') ?? 30000)))
console.log(`-- url: ${page.url()}  chars: ${out.length}`)
await client.close()
await browser.close()
