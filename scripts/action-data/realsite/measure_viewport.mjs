// Contract v1 measurement on saved Mind2Web pages: is the recorded target in the on-screen
// snapshot (viewportSnapshot), reachable with one find on its own name (findResult), and how big
// is AX, against the 18k boundedSnapshot of contract v0. Reuses the target refs that
// capture_mind2web.mjs wrote (actor.meta.jsonl) and checks each against the gold element.
//
// node measure_viewport.mjs --dir /workspace/action-train/realsite/m2w1 --out <dir> [--port 9481]

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { createConnection } from '@playwright/mcp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { boundedSnapshot, compactSnapshot, viewportSnapshot, stripBoxes, findResult, findRefs, targetText } from '../contract.mjs'

/** The page without its scripts, removed until none is left; an unclosed opener is made inert. */
const withoutScripts = (html) => {
  let text = html
  let previous
  do {
    previous = text
    text = text.replace(/<script\b[\s\S]*?<\/script\b[^>]*>/gi, '')
  } while (text !== previous)
  return text.replace(/<script/gi, '&lt;script')
}

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, v, i, all) => {
  if (v.startsWith('--')) pairs.push([v.slice(2), all[i + 1]])
  return pairs
}, []))
const dir = args.dir
const out = args.out ?? dir
const port = Number(args.port ?? 9481)
const VIEW = { width: 1280, height: 800 }
const STEP = Math.round(VIEW.height * 0.8) // scroll_down() moves 80% of the window height
const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))])

const meta = new Map(readFileSync(join(dir, 'meta.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { const m = JSON.parse(l); return [m.id, m] }))
const rows = readFileSync(join(dir, 'actor.meta.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
process.setMaxListeners(0)
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: [`--remote-debugging-port=${port}`] })
const context = await browser.newContext({ viewport: VIEW })
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
const client = new Client({ name: 'Off Grid AI realsite measure', version: '1' })
const [ct, st] = InMemoryTransport.createLinkedPair()
await Promise.all([server.connect(st), client.connect(ct)])
const tool = async (name, toolArgs) => {
  const r = await client.callTool({ name, arguments: toolArgs })
  const text = (r.content ?? []).map((p) => p.text ?? '').join('\n')
  return { text, isError: Boolean(r.isError) || text.startsWith('### Error') }
}

/** Top y of `ref` in viewport pixels, with iframe offsets added (same walk as viewportSnapshot). */
function topOf(boxed, ref) {
  const stack = []
  for (const line of boxed.split('\n')) {
    if (!/^\s*- /.test(line)) continue
    const indent = (line.match(/^\s*/) ?? [''])[0].length
    while (stack.length && stack.at(-1).indent >= indent) stack.pop()
    const off = stack.at(-1) ?? { dx: 0, dy: 0 }
    const b = line.match(/\[box=(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\]/)
    let { dx, dy } = off
    if (b && /^\s*- '?iframe\b/.test(line)) { dx = Number(b[1]) + off.dx; dy = Number(b[2]) + off.dy }
    stack.push({ indent, dx, dy })
    if (b && line.includes(`[ref=${ref}]`)) return { y: Number(b[2]) + off.dy, h: Number(b[4]) }
  }
  return null
}
const has = (text, refs) => refs.some((ref) => text.includes(`[ref=${ref}]`))

const results = []
const totals = { rows: rows.length, measured: 0, refMismatch: 0, errors: 0 }
for (const row of rows) {
  const m = meta.get(row.id)
  try {
    html = withoutScripts(readFileSync(join(dir, 'html', `${m.id}.html`), 'utf8'))
    host = `www.${m.website.replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'site'}.com`
    const nav = await withTimeout(tool('browser_navigate', { url: `https://${host}/` }), 30_000)
    if (nav.isError) { totals.errors++; continue }
    const boxed = (await withTimeout(tool('browser_snapshot', { boxes: true }), 30_000)).text
    const full = stripBoxes(boxed)
    // The refs come from an earlier load of the same page. Playwright MCP prefixes refs with a
    // per-navigation counter (f7e68), so only the eN part carries over: try every ref with that
    // suffix and keep the ones that point at the gold element.
    await page.evaluate((ids) => { for (const id of ids) document.querySelector(`[backend_node_id="${id}"]`)?.setAttribute('data-ogad-gold', '1') }, m.gold_ids)
    const allRefs = [...full.matchAll(/\[ref=((?:f\d+)?(e\d+))\]/g)]
    const refs = []
    for (const old of new Set(row.accepted.map((a) => a.match(/\(((?:f\d+)?e\d+)/)?.[1]).filter(Boolean))) {
      const suffix = old.replace(/^f\d+/, '')
      for (const ref of new Set(allRefs.filter((r) => r[2] === suffix).map((r) => r[1]))) {
        const check = await withTimeout(tool('browser_evaluate', { element: 'target', target: ref, function: '(el) => Boolean(el.closest("[data-ogad-gold]") || el.querySelector("[data-ogad-gold]"))' }), 10_000).catch(() => ({ isError: true }))
        if (!check.isError && /### Result\ntrue/.test(check.text)) refs.push(ref)
      }
    }
    if (!refs.length) { totals.refMismatch++; continue }
    const goal = m.task
    const focus = m.plan[m.current - 1]?.title ?? ''
    const v0 = boundedSnapshot(full, goal, focus)
    const top = viewportSnapshot(boxed, VIEW, focus, goal)
    const name = refs.map((ref) => targetText(full, ref)).find(Boolean) ?? ''
    const found = name ? findResult(full, name) : '0 matches'
    const pos = topOf(boxed, refs[0])
    // A real agent scrolls: scroll_down() steps until the target is inside the viewport.
    const k = pos ? Math.max(0, Math.ceil((pos.y + Math.min(pos.h, VIEW.height) - VIEW.height) / STEP)) : 0
    let scrolled = top
    let scrolledY = 0
    if (k > 0) {
      await page.evaluate((y) => window.scrollTo(0, y), k * STEP)
      scrolledY = await page.evaluate(() => window.scrollY)
      scrolled = viewportSnapshot((await withTimeout(tool('browser_snapshot', { boxes: true }), 30_000)).text, VIEW, focus, goal)
    }
    // Variants: what the extra screen below and the plan-step lines cost and buy.
    const variant = (below, withFocus) => { const t = viewportSnapshot(boxed, { ...VIEW, below }, withFocus ? focus : '', goal); return { chars: t.length, kept: has(t, refs) } }
    const variants = { b0f: variant(0, true), b1n: variant(1, false), b0n: variant(0, false) }
    results.push({ variants,
      id: m.id, website: m.website, op: m.op, name, targetY: pos?.y ?? null, scrolls: k, scrolledY,
      fullChars: compactSnapshot(full).length,
      v0Chars: v0.length, v0Kept: has(v0, refs),
      topChars: top.length, topKept: has(top, refs),
      findHit: findRefs(found).some((ref) => refs.includes(ref)), findCount: Number(found.match(/^\d+/)?.[0] ?? 0),
      scrolledChars: scrolled.length, scrolledKept: has(scrolled, refs)
    })
    totals.measured++
  } catch {
    totals.errors++
  }
  if ((totals.measured + totals.errors + totals.refMismatch) % 20 === 0) console.log(JSON.stringify(totals))
}

const n = results.length
const count = (f) => results.filter(f).length
const avg = (k) => Math.round(results.reduce((s, r) => s + r[k], 0) / Math.max(1, n))
const pct = (k, p) => { const v = results.map((r) => r[k]).sort((a, b) => a - b); return v[Math.min(v.length - 1, Math.floor(p * v.length))] ?? 0 }
const summary = {
  dir, ...totals,
  v0: { kept: count((r) => r.v0Kept), avgChars: avg('v0Chars'), p90Chars: pct('v0Chars', 0.9) },
  top: { kept: count((r) => r.topKept), keptOrFind: count((r) => r.topKept || r.findHit), avgChars: avg('topChars'), p50Chars: pct('topChars', 0.5), p90Chars: pct('topChars', 0.9) },
  find: { hit: count((r) => r.findHit), noName: count((r) => !r.name) },
  scrolled: { kept: count((r) => r.scrolledKept), keptOrFind: count((r) => r.scrolledKept || r.findHit), avgChars: avg('scrolledChars'), p90Chars: pct('scrolledChars', 0.9), neededScroll: count((r) => r.scrolls > 0) },
  fullAvgChars: avg('fullChars'),
  onlyByScroll: count((r) => !r.topKept && !r.findHit),
  variants: Object.fromEntries(['b0f', 'b1n', 'b0n'].map((k) => [k, { kept: count((r) => r.variants[k].kept), keptOrFind: count((r) => r.variants[k].kept || r.findHit), avgChars: Math.round(results.reduce((s, r) => s + r.variants[k].chars, 0) / Math.max(1, n)) }]))
}
writeFileSync(join(out, 'viewport-measure.jsonl'), results.map((r) => JSON.stringify(r)).join('\n') + '\n')
writeFileSync(join(out, 'viewport-summary.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary))
await client.close()
await browser.close()
