// Real-site actor test: load each saved Mind2Web page in Chromium, take OGAD's real Playwright
// snapshot, find the recorded target's ref, and write an actor test row in the new contract.
//
// node capture_mind2web.mjs --dir /workspace/action-train/realsite/m2w1

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { createConnection } from '@playwright/mcp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { actorRequest, boundedSnapshot } from '../contract.mjs'

/** The page without its scripts, removed until none is left. */
const withoutScripts = (html) => {
  let text = html
  let previous
  do {
    previous = text
    text = text.replace(/<script\b[\s\S]*?<\/script\b[^>]*>/gi, '')
  } while (text !== previous)
  // An opener with no closing tag survives the loop; make it inert text.
  return text.replace(/<script/gi, '&lt;script')
}

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, v, i, all) => {
  if (v.startsWith('--')) pairs.push([v.slice(2), all[i + 1]])
  return pairs
}, []))
const dir = args.dir
const port = Number(args.port ?? 9480)
const REF_LINE = /^(\s*)- (.*?)\s*\[ref=((?:f\d+)?e\d+)\]/
const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))])

const meta = readFileSync(join(dir, 'meta.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
process.setMaxListeners(0)
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: [`--remote-debugging-port=${port}`] })
// JavaScript stays on (OGAD's lookups run in the page); the saved pages' own scripts are removed,
// so each page stays exactly as Mind2Web saved it.
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await context.newPage()
let html = ''
let host = ''
await context.route('**/*', (route) => {
  const url = new URL(route.request().url())
  if (url.hostname === host && route.request().resourceType() === 'document') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html })
  return route.abort()
})
const server = await createConnection({
  browser: { browserName: 'chromium', cdpEndpoint: `http://127.0.0.1:${port}` },
  capabilities: ['core', 'core-navigation', 'core-tabs', 'core-input'],
  imageResponses: 'omit', snapshot: { mode: 'none', boxes: false },
  timeouts: { action: 10_000, navigation: 45_000, settle: 0 }
})
const client = new Client({ name: 'Off Grid AI realsite', version: '1' })
const [ct, st] = InMemoryTransport.createLinkedPair()
await Promise.all([server.connect(st), client.connect(ct)])
const tool = async (name, toolArgs) => {
  const r = await client.callTool({ name, arguments: toolArgs })
  const text = (r.content ?? []).map((p) => p.text ?? '').join('\n')
  return { text, isError: Boolean(r.isError) || text.startsWith('### Error') }
}

const out = join(dir, 'actor.jsonl')
const metaOut = join(dir, 'actor.meta.jsonl')
writeFileSync(out, '')
writeFileSync(metaOut, '')
const totals = { steps: meta.length, written: 0, noTarget: 0, cutBySnapshotLimit: 0, errors: 0 }
let done = 0

for (const m of meta) {
  try {
    html = withoutScripts(readFileSync(join(dir, 'html', `${m.id}.html`), 'utf8'))
    host = `www.${m.website.replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'site'}.com`
    const nav = await withTimeout(tool('browser_navigate', { url: `https://${host}/` }), 30_000)
    if (nav.isError) { totals.errors++; continue }
    const snapshot = (await withTimeout(tool('browser_snapshot', { boxes: false }), 30_000)).text
    // Mark the target, then ask about control and named lines one at a time (parallel calls on
    // pages with thousands of refs stalled). Marking uses a data attribute, which the snapshot
    // does not show, so refs do not shift.
    await page.evaluate((ids) => {
      for (const id of ids) document.querySelector(`[backend_node_id="${id}"]`)?.setAttribute('data-ogad-gold', '1')
    }, m.gold_ids)
    const candidates = snapshot.split('\n').map((l) => l.match(REF_LINE)).filter(Boolean)
      .filter(([, , d]) => !/^generic(?: \[active\])?$/.test(d.trim()))
    let refs = []
    const holders = []
    const deadline = Date.now() + 45_000 // a page that stalls is skipped, not waited on
    for (const [, indent, description, ref] of candidates) {
      if (Date.now() > deadline) break
      const r = await withTimeout(tool('browser_evaluate', {
        element: description.slice(0, 80), target: ref,
        function: '(el) => el.closest("[data-ogad-gold]") ? "in" : (el.querySelector("[data-ogad-gold]") ? "has" : null)'
      }), 10_000).catch(() => ({ isError: true }))
      const mark = r.isError ? null : JSON.parse(r.text.match(/### Result\n(.*)/)?.[1] ?? 'null')
      if (mark === 'in') refs.push(ref)
      else if (mark === 'has') holders.push({ ref, depth: indent.length })
    }
    if (!refs.length && holders.length) refs = [holders.sort((a, b) => b.depth - a.depth)[0].ref]
    if (!refs.length) { totals.noTarget++; continue }
    const goal = m.task
    const shown = boundedSnapshot(snapshot, goal, m.plan[m.current - 1]?.title ?? '')
    const inView = refs.some((ref) => shown.includes(`[ref=${ref}]`))
    if (!inView) totals.cutBySnapshotLimit++
    const q = JSON.stringify
    const accepted = refs.flatMap((ref) => m.op === 'TYPE' ? [`type(${ref},${q(m.value)})`]
      : m.op === 'SELECT' ? [`select(${ref},${q(m.value)})`, `click(${ref})`] : [`click(${ref})`])
    const request = actorRequest({ goal, plan: m.plan, current: m.current, past: m.past, snapshot })
    appendFileSync(out, JSON.stringify({ messages: [{ role: 'user', content: request }, { role: 'assistant', content: accepted[0] }], images: [join(dir, m.image)] }) + '\n')
    appendFileSync(metaOut, JSON.stringify({ id: m.id, family: m.domain, label: accepted[0], accepted, website: m.website, op: m.op, target_in_view: inView }) + '\n')
    totals.written++
  } catch {
    totals.errors++
  }
  if (++done % 20 === 0) console.log(JSON.stringify({ done, ...totals }))
}
writeFileSync(join(dir, 'capture-summary.json'), JSON.stringify(totals, null, 2))
console.log(JSON.stringify(totals))
await client.close()
await browser.close()
