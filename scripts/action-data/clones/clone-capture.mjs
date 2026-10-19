// Clone-farm training data: full tasks, writes included, on self-hosted open-source clones of
// mail, docs, chat, boards and social apps (hosts *.farm.test, all on our own server).
//
// Each app module (clones/apps/<app>.mjs) writes tasks as scripted episodes: a goal, a plan and the
// exact actions a person would take, found by role and name in the live snapshot. Every action must
// change the page, and at the end the app's own database or API must show the result. Only then are
// the rows written, built with contract.mjs exactly as live-capture.mjs builds them.
//
// Write actions (send, post, like, delete...) run ONLY on clone hosts: every action first checks the
// page URL against CLONE_HOST. live-capture.mjs keeps its UNSAFE filter for every other site.
//
//   xvfb-run -a node clones/clone-capture.mjs --app roundcube --episodes 300 --out /workspace/action-data/clones-roundcube
// Options: --worker n (CDP port 9700+n, file suffix), --seed s, --kinds a,b (only these task kinds),
// --reset-every n (reset the app before every n-th episode; writes always reset first).

import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { chromium } from 'playwright-core'
import { createConnection } from '@playwright/mcp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { plannerRequest, plannerResponse, actorRequest, evaluatorRequest } from '../contract.mjs'
import { createRng } from '../rng.mjs'
import { parseTree, findTargets, safeControls, CLONE_HOST } from './tree.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((p, v, i, all) => { if (v.startsWith('--')) p.push([v.slice(2), all[i + 1]]); return p }, []))
const worker = Number(args.worker ?? 0)
const out = args.out
const EPISODES = Number(args.episodes ?? 100)
const RESET_EVERY = Number(args['reset-every'] ?? 10)
const KINDS = args.kinds ? args.kinds.split(',') : null
const app = (await import(`./apps/${args.app}.mjs`)).default
const rng = createRng(`clone:${app.name}:${worker}:${args.seed ?? 'c1'}`)
const VIEWPORTS = [[1440, 900], [1366, 768], [1536, 864], [1280, 800]]
const port = Number(args.cdp ?? 9700 + worker + (app.portOffset ?? 0))

mkdirSync(join(out, 'images'), { recursive: true })
const files = Object.fromEntries(['actor', 'evaluator', 'planner', 'episodes'].map((k) => [k, join(out, `${k}-w${worker}.jsonl`)]))
const write = (file, row) => appendFileSync(file, JSON.stringify(row) + '\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])
const sh = (cmd, opts = {}) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000, ...opts })

process.setMaxListeners(0)
const [vw, vh] = rng.pick(VIEWPORTS)
let browser, context, page, client
/** Chrome + the Playwright MCP server on it, as OGAD runs them. Recreated when a run gets stuck. */
async function startBrowser() {
  browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? 'chrome', headless: false, args: [`--remote-debugging-port=${port}`, '--disable-blink-features=AutomationControlled', `--window-size=${vw},${vh + 120}`] })
  context = await browser.newContext({ viewport: { width: vw, height: vh }, locale: 'en-IN', timezoneId: 'Asia/Kolkata' })
  page = await context.newPage()
  const server = await createConnection({
    browser: { browserName: 'chromium', cdpEndpoint: `http://127.0.0.1:${port}` },
    capabilities: ['core', 'core-navigation', 'core-tabs', 'core-input'],
    imageResponses: 'omit', snapshot: { mode: 'none', boxes: false },
    timeouts: { action: 10_000, navigation: 45_000, settle: 350 }
  })
  client = new Client({ name: 'Off Grid AI clone-data', version: '1' })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(st), client.connect(ct)])
}
async function stopBrowser() {
  await timeout(client.close(), 10_000).catch(() => {})
  await timeout(browser.close(), 20_000).catch(() => {})
}
await startBrowser()
const tool = async (name, toolArgs) => {
  const r = await timeout(client.callTool({ name, arguments: toolArgs }), 60_000)
  const text = (r.content ?? []).map((p) => p.text ?? '').join('\n')
  return { text, isError: Boolean(r.isError) || text.startsWith('### Error') }
}

let shot = 0
async function observe(settle = 1200) {
  await sleep(settle)
  // A click may open a new tab: keep only the newest one.
  const pages = context.pages()
  if (pages.length > 1) { for (const p of pages.slice(0, -1)) await p.close().catch(() => {}); page = pages.at(-1) }
  const snapshot = (await tool('browser_snapshot', { boxes: false })).text
  // The seed is in the name: a resumed run in the same folder must never overwrite an earlier run's images.
  const image = `images/${app.name}-w${worker}-${args.seed ?? 'c1'}-${shot++}.jpg`
  await page.screenshot({ path: join(out, image), type: 'jpeg', quality: 65 }).catch(() => {})
  return { snapshot, image, url: page.url() }
}

const fingerprint = (snap) => snap.replace(/\[ref=[^\]]+\]/g, '').replace(/\s+/g, ' ')
const q = JSON.stringify
const onClone = () => CLONE_HOST.test(new URL(page.url()).hostname)

/** One action, run the way OGAD's harness runs it (capture.mjs execute). */
async function execute(call, element) {
  if (!onClone()) throw new Error(`not a clone host: ${page.url()}`)
  switch (call.do) {
    case 'click': case 'check': case 'uncheck': return tool('browser_click', { element, target: call.ref })
    // ACTION_VOCABULARY: dblclick(t) / rightclick(t) (a row's context menu, an inline cell editor).
    case 'dblclick': return tool('browser_click', { element, target: call.ref, doubleClick: true })
    case 'rightclick': return tool('browser_click', { element, target: call.ref, button: 'right' })
    // slowly: key-by-key typing for contenteditable editors where fill() does nothing (Etherpad).
    // The label is the same type(ref,"text"); OGAD's harness must fall back the same way on such editors.
    case 'type': return tool('browser_type', { element, target: call.ref, text: call.text, submit: false, slowly: Boolean(call.slowly) })
    case 'select': return tool('browser_select_option', { element, target: call.ref, values: [call.value] })
    case 'press': return tool('browser_press_key', { key: call.key })
    case 'drag': return tool('browser_drag', { startElement: element, startTarget: call.ref, endElement: call.toName, endTarget: call.toRef })
    default: throw new Error(`unsupported ${call.do}`)
  }
}

function actionText(step, ref, toRef) {
  switch (step.do) {
    case 'type': return `type(${ref},${q(step.text)})`
    case 'select': return `select(${ref},${q(step.value)})`
    case 'press': return `press(${q(step.key)})`
    case 'drag': return `drag(${ref},${toRef})`
    default: return `${step.do}(${ref})`
  }
}

// The snapshot where a target was missing, for fixing the app module (first 40 only).
let dumps = 0
function dumpFailure(id, i, snapshot) {
  if (dumps++ >= 40) return
  mkdirSync(join(out, 'fail'), { recursive: true })
  writeFileSync(join(out, 'fail', `${id.split(':').pop()}-step${i + 1}.yaml`), snapshot)
}

/**
 * Runs one scripted episode. Rows are buffered and written only when every action changed the page
 * and the app's own state shows the goal was met.
 */
async function episode(spec, id) {
  const rows = { actor: [], evaluator: [], planner: [] }
  if (spec.start) { await tool('browser_navigate', { url: new URL(spec.start, app.origin).href }); await sleep(spec.startWait ?? 1500) }
  if (!onClone()) return { ok: false, reason: 'start is not a clone host' }
  let obs = await observe()
  const { goal, plan } = spec
  rows.planner.push({ id: `${id}:plan`, seed: id, kind: 'plan', request: plannerRequest({ goal, snapshot: obs.snapshot }), response: plannerResponse(plan) })
  rows.evaluator.push({ id: `${id}:e0`, seed: id, family: spec.family, request: evaluatorRequest({ goal, plan, current: 1, past: [], last: 'task started', snapshot: obs.snapshot }), image: obs.image, response: 'continue(1)' })
  const past = []
  const steps = spec.steps
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    if (step.before) await step.before(page)
    let ref = null; let accepted = []; let element = ''; let toRef = null; let toName = ''
    if (step.do !== 'press') {
      const tree = parseTree(obs.snapshot)
      const found = findTargets(tree, step.target)
      if (!found.length) {
        // An optional step may be missing (a dialog that only sometimes shows); never the last one.
        if (step.optional && i < steps.length - 1) continue
        dumpFailure(id, i, obs.snapshot)
        return { ok: false, reason: `step ${i + 1}: no ${JSON.stringify(step.target, (k, v) => v instanceof RegExp ? String(v) : v)}` }
      }
      const pick = found[Math.min(step.target.nth ?? 0, found.length - 1)]
      ref = pick.ref; element = pick.name || pick.role
      const same = step.target.only ? [pick] : found
      if (step.do === 'drag') {
        const to = findTargets(tree, step.to)
        if (!to.length) return { ok: false, reason: `step ${i + 1}: no drop target` }
        const toPick = to[Math.min(step.to.nth ?? 0, to.length - 1)]
        toRef = toPick.ref; toName = toPick.name || toPick.role
        accepted = same.map((n) => actionText(step, n.ref, toRef))
      } else accepted = same.map((n) => actionText(step, n.ref))
    }
    const action = actionText(step, ref, toRef)
    accepted = [...new Set([action, ...accepted])]
    rows.actor.push({ id: `${id}:a${i}`, seed: id, family: spec.family, request: actorRequest({ goal, plan, current: step.plan, past, snapshot: obs.snapshot }), image: obs.image, response: action, accepted })
    const urlBefore = page.url()
    const res = await execute({ ...step, ref, toRef, toName }, element)
    if (res.isError) return { ok: false, reason: `step ${i + 1} ${action}: ${res.text.slice(0, 160)}` }
    const before = obs
    obs = await observe(step.settle ?? 1200)
    const changed = obs.url !== urlBefore || fingerprint(obs.snapshot) !== fingerprint(before.snapshot)
    if (!changed && !step.mayNotChange) return { ok: false, reason: `step ${i + 1} ${action}: page did not change` }
    past.push(`${action} -> ok, ${changed ? 'page changed' : 'no visible change'}`)
    const last = past.at(-1)
    if (i < steps.length - 1) {
      const next = steps.slice(i + 1).find(Boolean).plan
      rows.evaluator.push({ id: `${id}:e${i + 1}`, seed: id, family: spec.family, request: evaluatorRequest({ goal, plan, current: step.plan, past, last, snapshot: obs.snapshot }), image: obs.image, response: `continue(${next})` })
    } else {
      // The goal is met only when the app's own state shows it.
      let verified = false
      for (let t = 0; t < 8 && !verified; t++) { verified = await spec.verify({ sh, page, snapshot: obs.snapshot }).catch(() => false); if (!verified) await sleep(1000) }
      if (!verified) return { ok: false, reason: 'state check failed' }
      if (spec.finalSettle) obs = await observe(spec.finalSettle)
      rows.evaluator.push({ id: `${id}:e${i + 1}`, seed: id, family: spec.family, request: evaluatorRequest({ goal, plan, current: step.plan, past, last, snapshot: obs.snapshot }), image: obs.image, response: `success(${q(spec.answer)})` })
    }
  }
  for (const role of ['actor', 'evaluator', 'planner']) for (const r of rows[role]) write(files[role], r)
  return { ok: true, rows: rows.actor.length }
}

/** A plain navigation task, like live-capture's, on the clone (no write controls). */
async function exploreSpec() {
  await tool('browser_navigate', { url: new URL(rng.pick(app.explorePaths ?? ['/']), app.origin).href })
  await sleep(1500)
  const snapshot = (await tool('browser_snapshot', { boxes: false })).text
  const list = safeControls(parseTree(snapshot)).filter((c) => /^(link|button|tab|menuitem)$/.test(c.role))
  if (!list.length) return null
  const pick = rng.pick(list)
  const verbs = pick.role === 'link' ? ['Open', 'Go to', 'Show me'] : ['Click', 'Open', 'Use']
  const title = `${pick.role === 'link' ? 'Open' : 'Click'} ${pick.name}`
  return {
    kind: 'explore', writes: false, goal: `${rng.pick(verbs)} ${pick.name}.`, answer: `Opened ${pick.name}`,
    plan: [{ title, check: `the ${pick.name} page or panel is shown` }],
    steps: [{ plan: 1, do: 'click', target: { role: pick.role, name: pick.name } }],
    verify: async () => true
  }
}

const reset = async () => { await app.reset({ sh }); await app.login({ page, sh, tool, sleep }) }
const totals = { app: app.name, episodes: 0, verified: 0, rows: 0, byKind: {}, failures: {} }
const kinds = Object.keys(app.tasks).filter((name) => !KINDS || KINDS.includes(name))
await reset()
let dirty = false
let failStreak = 0
for (let n = 0; n < EPISODES; n++) {
  // A failed reset can leave the tab or the MCP session dead (every snapshot empty): after 6 failures in a
  // row, start a fresh browser and reset the app before going on.
  if (failStreak >= 6) {
    failStreak = 0
    await stopBrowser()
    await startBrowser()
    try { await reset(); dirty = false } catch { dirty = true }
    totals.browserRestarts = (totals.browserRestarts ?? 0) + 1
  }
  const kind = app.explorePaths && (!KINDS || KINDS.includes('explore')) && rng.chance(0.15) ? 'explore' : rng.pick(kinds)
  const id = `clone:${app.name}:w${worker}:${args.seed ?? 'c1'}:t${n}`
  totals.episodes++
  let result
  try {
    if (dirty || n % RESET_EVERY === RESET_EVERY - 1) { await reset(); dirty = false }
    const spec = kind === 'explore' ? await exploreSpec() : await app.tasks[kind]({ rng, sh, page, tool, sleep })
    if (!spec) { result = { ok: false, reason: 'no task' } } else {
      spec.family ??= `clone-${app.family}`
      dirty = spec.writes !== false
      result = await episode(spec, id)
    }
  } catch (error) {
    result = { ok: false, reason: String(error?.message ?? error).slice(0, 200) }
    dirty = true
  }
  const k = totals.byKind[kind] ??= { tried: 0, verified: 0 }
  k.tried++
  failStreak = result.ok ? 0 : failStreak + 1
  if (result.ok) { k.verified++; totals.verified++; totals.rows += result.rows } else totals.failures[`${kind}: ${result.reason.slice(0, 90)}`] = (totals.failures[`${kind}: ${result.reason.slice(0, 90)}`] ?? 0) + 1
  write(files.episodes, { seed: id, app: app.name, kind, completed: result.ok, reason: result.reason })
  if (n % 10 === 9) writeFileSync(join(out, `summary-w${worker}.json`), JSON.stringify(totals, null, 2))
}
writeFileSync(join(out, `summary-w${worker}.json`), JSON.stringify(totals, null, 2))
console.log(JSON.stringify({ app: totals.app, episodes: totals.episodes, verified: totals.verified, rows: totals.rows }))
await stopBrowser()
