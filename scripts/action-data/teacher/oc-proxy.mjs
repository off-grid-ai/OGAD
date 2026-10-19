// Teacher logger: an MCP server (stdio) that wraps Playwright MCP, the same browser tools OGAD uses.
// A large teacher model (run inside the OpenCode CLI) browses through it; every screen it acts on
// is saved as OGAD-contract rows, built with contract.mjs exactly as the harness builds requests:
//   actor     (screen before the action -> the teacher's action, mapped to the action vocabulary)
//   evaluator (screen -> continue(n); the final screen -> success("answer") or fail("reason"))
//   planner   (first screen -> the teacher's plan)
//
//   node oc-proxy.mjs --task task.json --out <dir>
// task.json: { "id", "goal", "url", "writes": false }. With writes false (public sites), controls
// that look like buy / send / post / sign in are refused, as in live-capture.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { createConnection } from '@playwright/mcp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { plannerRequest, plannerResponse, actorRequest, evaluatorRequest, boundedSnapshot } from '../contract.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((p, v, i, all) => { if (v.startsWith('--')) p.push([v.slice(2), all[i + 1]]); return p }, []))
const task = JSON.parse(readFileSync(args.task, 'utf8'))
const out = args.out
mkdirSync(join(out, 'images'), { recursive: true })
const files = Object.fromEntries(['actor', 'evaluator', 'planner', 'episodes'].map((k) => [k, join(out, `${k}.jsonl`)]))
const write = (file, row) => appendFileSync(file, JSON.stringify(row) + '\n')
const log = (...a) => process.stderr.write(a.join(' ') + '\n')

const UNSAFE = /\b(buy|add to (cart|bag|basket)|checkout|pay|place order|order now|subscribe|sign ?in|log ?in|sign ?up|register|create account|follow|like|post|tweet|reply|repost|share|delete|remove|report|download|install|apply|book|donate|send|submit|logout|log out|sell|bid|reserve|upgrade)\b/i
const REF_LINE = /^(\s*)- '?(.*?)\s*\[ref=((?:f\d+)?e\d+)\]/
// Tools the teacher may use; anything that runs page code or touches files is not offered.
const ALLOWED = new Set(['browser_snapshot', 'browser_click', 'browser_type', 'browser_select_option', 'browser_press_key', 'browser_navigate', 'browser_navigate_back', 'browser_hover', 'browser_wait_for', 'browser_tabs'])
const ACTIONS = new Set(['browser_click', 'browser_type', 'browser_select_option', 'browser_press_key', 'browser_navigate', 'browser_navigate_back', 'browser_hover'])

// ---------- browser (started after the MCP handshake, so the client never waits on it) ----------
let page, browser
// Playwright MCP connects to the browser lazily, so its tool list is ready at once.
const port = 9800 + Math.floor(Math.random() * 150)
const pw = await createConnection({
  browser: { browserName: 'chromium', cdpEndpoint: `http://127.0.0.1:${port}` },
  capabilities: ['core', 'core-navigation', 'core-tabs', 'core-input'],
  imageResponses: 'omit', snapshot: { mode: 'none', boxes: false },
  timeouts: { action: 10_000, navigation: 45_000, settle: 350 }
})
const client = new Client({ name: 'ogad-teacher', version: '1' })
{ const [ct, st] = InMemoryTransport.createLinkedPair(); await Promise.all([pw.connect(st), client.connect(ct)]) }
const call = async (name, a) => { await ready; const r = await client.callTool({ name, arguments: a }); return { r, text: (r.content ?? []).map((p) => p.text ?? '').join('\n') } }
async function start() {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: false, args: [`--remote-debugging-port=${port}`, '--disable-blink-features=AutomationControlled', '--window-size=1440,1000'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-IN', timezoneId: 'Asia/Kolkata' })
  page = await context.newPage()
  await client.callTool({ name: 'browser_navigate', arguments: { url: task.url } })
}
let ready

// ---------- episode state ----------
let plan = []
let current = 1
const past = []
let shot = 0
let planned = false
const observe = async () => {
  await new Promise((r) => setTimeout(r, 600))
  const snapshot = (await call('browser_snapshot', { boxes: false })).text
  const image = `images/${task.id}-${shot++}.jpg`
  await page.screenshot({ path: join(out, image), type: 'jpeg', quality: 65 }).catch(() => {})
  // The same screen with element boxes, so rows can be re-rendered as the on-screen view later.
  const boxed = (await call('browser_snapshot', { boxes: true })).text
  write(join(out, 'boxed.jsonl'), { image, viewport: { width: 1440, height: 900 }, boxed })
  return { snapshot, image }
}
const lineFor = (snapshot, ref) => snapshot.split('\n').map((l) => l.match(REF_LINE)).find((m) => m?.[3] === ref)?.[2]
const q = (s) => JSON.stringify(String(s))
function vocab(name, a) {
  const ref = a.target ?? a.ref
  switch (name) {
    case 'browser_click': return a.doubleClick ? `dblclick(${ref})` : `click(${ref})`
    case 'browser_type': return `type(${ref},${q(a.text ?? '')})`
    case 'browser_select_option': return `select(${ref},${q((a.values ?? [])[0] ?? '')})`
    case 'browser_press_key': return `press(${q(a.key)})`
    case 'browser_navigate': return `goto(${q(a.url)})`
    case 'browser_navigate_back': return 'back()'
    case 'browser_hover': return `move(${ref})`
  }
  return null
}
const finish = (end, detail) => { write(files.episodes, { id: task.id, goal: task.goal, url: task.url, end, detail, actions: past.length, plan: plan.map((s) => s.title) }); writeFileSync(join(out, `${task.id}.done`), end) }

// ---------- the MCP server the teacher talks to ----------
const OWN = [
  { name: 'ogad_plan', description: 'Call FIRST, after looking at the page. Give the plan as short steps that each name what to act on, e.g. "Type boAt Airdopes 141 in Search". Add a check after " | check: " when you can, e.g. "Open the first result | check: page shows Add to Cart". Call again to re-plan from the current step when the page is not what the plan expected.', inputSchema: { type: 'object', properties: { steps: { type: 'array', items: { type: 'string' } } }, required: ['steps'] } },
  { name: 'ogad_step', description: 'Call before acting to say which plan step (1-based) you are on now.', inputSchema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] } },
  { name: 'ogad_done', description: 'Call when the goal is met. answer = the specific answer the user asked for (names, prices, numbers), copied from the page. Never a description of what you did.', inputSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } },
  { name: 'ogad_fail', description: 'Call when the goal cannot be done (login wall, missing item, blocked).', inputSchema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } }
]
const server = new Server({ name: 'ogad-browser', version: '1' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const { tools } = await client.listTools()
  return { tools: [...OWN, ...tools.filter((t) => ALLOWED.has(t.name))] }
})
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params
  const text = (t) => ({ content: [{ type: 'text', text: t }] })
  try {
    if (name === 'ogad_plan') {
      const steps = (a.steps ?? []).map((s) => { const [title, check] = String(s).split(/\s*\|\s*check:\s*/); return { title: title.trim(), check: (check ?? '').trim() } })
      const obs = await observe()
      if (!planned) write(files.planner, { id: `${task.id}:plan`, seed: task.id, kind: 'plan', request: plannerRequest({ goal: task.goal, snapshot: obs.snapshot }), response: plannerResponse(steps) })
      else write(files.planner, { id: `${task.id}:replan${past.length}`, seed: task.id, kind: 'replan', request: plannerRequest({ goal: task.goal, snapshot: obs.snapshot, done: plan.slice(0, current - 1), reason: 'the page is not what the plan expected' }), response: plannerResponse(steps, current) })
      plan = planned ? [...plan.slice(0, current - 1), ...steps] : steps
      planned = true
      return text(`Plan saved (${plan.length} steps). Current step: ${current}.`)
    }
    if (name === 'ogad_step') { current = Math.max(1, Math.min(plan.length || 1, Number(a.n) || 1)); return text(`Current step: ${current}.`) }
    if (name === 'ogad_done' || name === 'ogad_fail') {
      const obs = await observe()
      const verdict = name === 'ogad_done' ? `success(${q(a.answer)})` : `fail(${q(a.reason)})`
      if (plan.length) write(files.evaluator, { id: `${task.id}:end`, seed: task.id, family: 'teacher', request: evaluatorRequest({ goal: task.goal, plan, current, past, last: past.at(-1) ?? 'task started', snapshot: obs.snapshot }), image: obs.image, response: verdict, answer: a.answer ?? null })
      finish(name === 'ogad_done' ? 'success' : 'fail', a.answer ?? a.reason)
      setTimeout(() => process.exit(0), 300)
      return text('Recorded. The task is finished; stop now.')
    }
    if (!ALLOWED.has(name)) return text(`Tool ${name} is not available.`)
    // Snapshots stay inline (no file), so every screen the teacher reads is one we record.
    // The teacher reads the same compacted, focused page text the small actor gets (60k cap):
    // one view for both, and huge pages (GitHub) no longer stall the teacher.
    if (name === 'browser_snapshot') {
      const raw = (await call(name, { boxes: false })).text
      return text(boundedSnapshot(raw, task.goal, plan[current - 1]?.title ?? '', 60000))
    }
    if (!ACTIONS.has(name)) return (await call(name, a)).r
    // type + submit is two actions in OGAD's vocabulary: type, then press Enter.
    if (name === 'browser_type' && a.submit) {
      const first = await act('browser_type', { ...a, submit: false })
      if (first.r.isError) return first.r
      return (await act('browser_press_key', { key: 'Enter' })).r
    }
    return (await act(name, a)).r
  } catch (e) {
    log('tool error', name, String(e))
    return text(`Error: ${String(e).slice(0, 200)}`)
  }
})

// One action: record the screen it was taken on (evaluator continue + actor action), then run it.
async function act(name, a) {
  // The semicolon ends the arrow: without it the TypeScript parser (ESLint) reads the block below
  // as part of it.
  const text = (t) => ({ r: { content: [{ type: 'text', text: t }], isError: true } });
  {
    if (!planned) return text('Call ogad_plan first.')
    const obs = await observe()
    const action = vocab(name, a)
    const ref = a.target ?? a.ref
    const element = ref ? lineFor(obs.snapshot, ref) : null
    if (ref && !element) return text(`Error: ref ${ref} is not on the page now. Take a new browser_snapshot.`)
    if (!task.writes && element && UNSAFE.test(element)) return text(`Refused: "${element}" changes something for real. Find another way, or call ogad_fail.`)
    // Rows for the screen the teacher acted on: the evaluator says continue, the actor acts.
    write(files.evaluator, { id: `${task.id}:e${past.length}`, seed: task.id, family: 'teacher', request: evaluatorRequest({ goal: task.goal, plan, current, past, last: past.at(-1) ?? 'task started', snapshot: obs.snapshot }), image: obs.image, response: `continue(${current})` })
    const before = obs.snapshot
    const res = await call(name, a)
    const after = (await call('browser_snapshot', { boxes: false })).text
    const isError = Boolean(res.r.isError) || res.text.startsWith('### Error')
    const result = isError ? `error ${res.text.replace(/\s+/g, ' ').slice(0, 100)}` : after !== before ? 'ok, page changed' : 'ok, no visible change'
    if (action && !isError) write(files.actor, { id: `${task.id}:a${past.length}`, seed: task.id, family: 'teacher', request: actorRequest({ goal: task.goal, plan, current, past, snapshot: before }), image: obs.image, response: action, accepted: [action] })
    past.push(`${action} -> ${result}`)
    if (past.length >= 60) { finish('gave_up', 'action limit'); setTimeout(() => process.exit(0), 300) }
    return res
  }
}
process.on('exit', () => { browser?.close().catch(() => {}) })
await server.connect(new StdioServerTransport())
ready = start()
log('ogad teacher proxy ready', task.id)
