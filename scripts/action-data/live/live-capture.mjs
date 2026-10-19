// Live-site training data: real pages of top websites, in OGAD's exact snapshot format.
//
// For each site the worker opens public pages in a real (headed) Chrome, picks a visible safe
// control, writes a goal from its accessible name, runs the action and keeps the rows only if
// the page reacted. Search boxes give two-step tasks (type, then Enter). Nothing that logs in,
// buys, posts, follows, submits a form (other than search) or downloads is ever touched.
//
//   xvfb-run -a node live-capture.mjs --sites sites.txt --worker 0 --workers 6 --out /workspace/action-data/live1
// Each worker takes every Nth site. Requests are paced: at least --gap ms between actions.

import { mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { createConnection } from '@playwright/mcp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { plannerRequest, plannerResponse, actorRequest, evaluatorRequest } from '../contract.mjs'
import { createRng } from '../rng.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((p, v, i, all) => { if (v.startsWith('--')) p.push([v.slice(2), all[i + 1]]); return p }, []))
const worker = Number(args.worker ?? 0)
const workers = Number(args.workers ?? 1)
const out = args.out
const GAP = Number(args.gap ?? 3000)
const TASKS_PER_SITE = Number(args.tasks ?? 25)
const port = 9600 + worker
const sites = readFileSync(args.sites, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean).filter((_, i) => i % workers === worker)
const rng = createRng(`live:${worker}:${args.seed ?? 'live1'}`)

// A name with a colon makes the YAML line single-quoted: - 'link "A: B" [ref=e1]'
const REF_LINE = /^(\s*)- '?(\w+)(?: "((?:[^"\\]|\\.)*)")?(.*?)\[ref=((?:f\d+)?e\d+)\]/
const UNSAFE = /\b(buy|add to (cart|bag|basket|wishlist)|checkout|pay|place order|order now|subscribe|sign ?in|log ?in|sign ?up|register|join|create account|follow|like|post|tweet|reply|repost|share|delete|remove|report|download|install|apply|book|donate|send|submit|call|whatsapp|chat|message|logout|log out|sell|bid|rent|reserve|try free|start free|get started|upgrade|premium)\b/i
const QUERIES = ['running shoes', 'wireless earbuds', 'coffee mug', 'laptop stand', 'monsoon jacket', 'cricket bat', 'python tutorial', 'weather today', 'pizza near me', 'electric scooter', 'yoga mat', 'office chair']
const VIEWPORTS = [[1440, 900], [1366, 768], [1536, 864], [1280, 800]]

mkdirSync(join(out, 'images'), { recursive: true })
const files = Object.fromEntries(['actor', 'evaluator', 'planner', 'episodes'].map((k) => [k, join(out, `${k}-w${worker}.jsonl`)]))
const write = (file, row) => appendFileSync(file, JSON.stringify(row) + '\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])

process.setMaxListeners(0)
const [vw, vh] = rng.pick(VIEWPORTS)
const launchArgs = [`--remote-debugging-port=${port}`, '--disable-blink-features=AutomationControlled', `--window-size=${vw},${vh + 120}`]
// --profile <dir>: a copy of a signed-in browser profile (logged-in pages); --browser <path> picks
// the binary that made it (Brave), so its stored cookies decrypt.
const context = args.profile
  ? await chromium.launchPersistentContext(args.profile, { executablePath: args.browser, headless: false, args: launchArgs, viewport: { width: vw, height: vh } })
  : await (await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? 'chrome', headless: false, args: launchArgs })).newContext({ viewport: { width: vw, height: vh }, locale: 'en-IN', timezoneId: 'Asia/Kolkata' })
const browser = context.browser() ?? context
const page = await context.newPage()
const server = await createConnection({
  browser: { browserName: 'chromium', cdpEndpoint: `http://127.0.0.1:${port}` },
  capabilities: ['core', 'core-navigation', 'core-tabs', 'core-input'],
  imageResponses: 'omit', snapshot: { mode: 'none', boxes: false },
  // Live pages load and animate: keep OGAD's real 350 ms settle.
  timeouts: { action: 10_000, navigation: 45_000, settle: 350 }
})
const client = new Client({ name: 'Off Grid AI live-data', version: '1' })
const [ct, st] = InMemoryTransport.createLinkedPair()
await Promise.all([server.connect(st), client.connect(ct)])
const tool = async (name, toolArgs) => {
  const r = await timeout(client.callTool({ name, arguments: toolArgs }), 60_000)
  const text = (r.content ?? []).map((p) => p.text ?? '').join('\n')
  return { text, isError: Boolean(r.isError) || text.startsWith('### Error') }
}

let shot = 0
async function observe(tag) {
  await sleep(1200)
  const snapshot = (await tool('browser_snapshot', { boxes: false })).text
  const image = `images/w${worker}-${tag}-${shot++}.jpg`
  await page.screenshot({ path: join(out, image), type: 'jpeg', quality: 65 }).catch(() => {})
  return { snapshot, image, url: page.url() }
}

/** Safe controls in a snapshot, with what a person would call them. */
function controls(snapshot) {
  const found = []
  for (const line of snapshot.split('\n')) {
    const m = line.match(REF_LINE)
    if (!m) continue
    const [, , role, rawName, , ref] = m
    const name = (rawName ?? '').replace(/\\"/g, '"').trim()
    if (!name || name.length < 2 || name.length > 60 || UNSAFE.test(name)) continue
    if (role === 'link' || role === 'button' || role === 'tab' || role === 'menuitem') found.push({ kind: 'click', role, name, ref, line: line.trim() })
    else if ((role === 'searchbox' || role === 'combobox' || role === 'textbox') && /search|find|looking for|what are you/i.test(name)) found.push({ kind: 'search', role, name, ref, line: line.trim() })
  }
  return found
}

const fingerprint = (snap) => snap.replace(/\[ref=[^\]]+\]/g, '').replace(/\s+/g, ' ').slice(0, 20000)

/** One task on the current page. Returns true when a verified action was recorded. */
async function task(site, n) {
  const before = await observe('t')
  const list = controls(before.snapshot)
  if (!list.length) return false
  const searches = list.filter((c) => c.kind === 'search')
  const pick = searches.length && rng.chance(0.25) ? rng.pick(searches) : rng.pick(list.filter((c) => c.kind === 'click'))
  if (!pick) return false
  const q = JSON.stringify
  const id = `live:${site}:w${worker}:t${n}`
  if (pick.kind === 'search') {
    const query = rng.pick(QUERIES)
    const goal = rng.pick([`Search ${site} for ${query}.`, `Find ${query} on this site.`, `Look up "${query}".`])
    const plan = [{ title: `Type ${query} in ${pick.name}`, check: `searchbox "${pick.name}" = ${query}` }, { title: 'Press Enter to search', check: 'search results are shown' }]
    write(files.planner, { id: `${id}:plan`, seed: id, kind: 'plan', request: plannerRequest({ goal, snapshot: before.snapshot }), response: plannerResponse(plan) })
    write(files.evaluator, { id: `${id}:e0`, seed: id, family: 'live', request: evaluatorRequest({ goal, plan, current: 1, past: [], last: 'task started', snapshot: before.snapshot }), image: before.image, response: 'continue(1)' })
    const typeAction = `type(${pick.ref},${q(query)})`
    write(files.actor, { id: `${id}:a0`, seed: id, family: 'live', request: actorRequest({ goal, plan, current: 1, past: [], snapshot: before.snapshot }), image: before.image, response: typeAction, accepted: [typeAction] })
    const typed = await tool('browser_type', { element: pick.name, target: pick.ref, text: query, submit: false, slowly: false })
    if (typed.isError) return false
    await sleep(GAP)
    const mid = await observe('t')
    const past = [`${typeAction} -> ok, page changed`]
    write(files.evaluator, { id: `${id}:e1`, seed: id, family: 'live', request: evaluatorRequest({ goal, plan, current: 1, past, last: past[0], snapshot: mid.snapshot }), image: mid.image, response: 'continue(2)' })
    write(files.actor, { id: `${id}:a1`, seed: id, family: 'live', request: actorRequest({ goal, plan, current: 2, past, snapshot: mid.snapshot }), image: mid.image, response: 'press("Enter")', accepted: ['press("Enter")'] })
    const urlBefore = page.url()
    await tool('browser_press_key', { key: 'Enter' })
    await sleep(GAP)
    const after = await observe('t')
    const ok = after.url !== urlBefore || fingerprint(after.snapshot) !== fingerprint(mid.snapshot)
    const past2 = [...past, `press("Enter") -> ok, ${ok ? 'page changed' : 'no visible change'}`]
    write(files.evaluator, { id: `${id}:e2`, seed: id, family: 'live', request: evaluatorRequest({ goal, plan, current: 2, past: past2, last: past2.at(-1), snapshot: after.snapshot }), image: after.image, response: ok ? `success(${q(`Search results for ${query}`)})` : 'replan("the search did not run")' })
    write(files.episodes, { seed: id, site, kind: 'search', completed: ok })
    return ok
  }
  const verbs = pick.role === 'link' ? ['Open', 'Go to', 'Show me'] : ['Click', 'Open', 'Use']
  const goal = `${rng.pick(verbs)} ${pick.name}${pick.role === 'link' && rng.chance(0.5) ? ' on this site' : ''}.`
  const plan = [{ title: `${pick.role === 'link' ? 'Open' : 'Click'} ${pick.name}`, check: `the ${pick.name} page or panel is shown` }]
  // Every control with the same role and name counts as correct (sites repeat links).
  const same = list.filter((c) => c.role === pick.role && c.name === pick.name).map((c) => `click(${c.ref})`)
  const action = `click(${pick.ref})`
  write(files.planner, { id: `${id}:plan`, seed: id, kind: 'plan', request: plannerRequest({ goal, snapshot: before.snapshot }), response: plannerResponse(plan) })
  write(files.evaluator, { id: `${id}:e0`, seed: id, family: 'live', request: evaluatorRequest({ goal, plan, current: 1, past: [], last: 'task started', snapshot: before.snapshot }), image: before.image, response: 'continue(1)' })
  const urlBefore = page.url()
  const clicked = await tool('browser_click', { element: pick.name, target: pick.ref })
  if (clicked.isError) return false
  await sleep(GAP)
  // A click may open a new tab: follow it so the next task starts there.
  const pages = context.pages()
  if (pages.length > 1) { for (const p of pages.slice(0, -1)) if (p !== page) await p.close().catch(() => {}) }
  const after = await observe('t')
  const ok = after.url !== urlBefore || fingerprint(after.snapshot) !== fingerprint(before.snapshot)
  if (!ok) { write(files.episodes, { seed: id, site, kind: 'click', completed: false, reason: 'no change' }); return false }
  // Only verified clicks become actor rows.
  write(files.actor, { id: `${id}:a0`, seed: id, family: 'live', request: actorRequest({ goal, plan, current: 1, past: [], snapshot: before.snapshot }), image: before.image, response: action, accepted: [...new Set(same)] })
  const last = `${action} -> ok, page changed`
  write(files.evaluator, { id: `${id}:e1`, seed: id, family: 'live', request: evaluatorRequest({ goal, plan, current: 1, past: [last], last, snapshot: after.snapshot }), image: after.image, response: `success(${q(`Opened ${pick.name}`)})` })
  write(files.episodes, { seed: id, site, kind: 'click', completed: true })
  return true
}

const totals = { sites: 0, reachable: 0, tasks: 0, verified: 0, blocked: [] }
for (const site of sites) {
  totals.sites++
  try {
    const nav = await tool('browser_navigate', { url: `https://${site}/` })
    await sleep(3000)
    const first = (await tool('browser_snapshot', { boxes: false })).text
    if (nav.isError || (first.match(/\[ref=/g) ?? []).length < 15) { totals.blocked.push(site); continue }
    totals.reachable++
    let n = 0
    for (let i = 0; i < TASKS_PER_SITE * 2 && n < TASKS_PER_SITE; i++) {
      totals.tasks++
      const ok = await task(site, i).catch(() => false)
      if (ok) { n++; totals.verified++ }
      await sleep(GAP)
      // Stay on the site: return home when a click left it or every few tasks.
      if (!new URL(page.url()).hostname.endsWith(site.replace(/^www\./, '')) || i % 5 === 4) {
        await tool('browser_navigate', { url: `https://${site}/` }).catch(() => {})
        await sleep(2000)
      }
    }
  } catch (error) {
    totals.blocked.push(`${site} (${String(error).slice(0, 40)})`)
  }
}
writeFileSync(join(out, `summary-w${worker}.json`), JSON.stringify(totals, null, 2))
console.log(JSON.stringify(totals))
await client.close()
await browser.close()
