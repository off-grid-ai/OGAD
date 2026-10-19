// Teacher-labelled recovery data (DAgger): our small models drive real tasks; on every screen they
// reach, the teacher writes the correct next action (and verdict). Rows are saved where the small
// model actually goes, including after its own mistakes, loops and unsafe clicks.
//
//   node dagger.mjs --tasks tasks.json --out <dir> --worker 0 --workers 8 \
//     --planner http://127.0.0.1:8091 --actor http://127.0.0.1:8092 --evaluator http://127.0.0.1:8093 \
//     --teacher http://127.0.0.1:8095/v1 --teacher-model qwen38 [--follow 0.6] [--max-steps 25]
//
// Each screen gives: actor rows in both AX views (full 18k and on-screen) labelled with the teacher's
// action, and an evaluator row labelled with the teacher's verdict. Execution follows the student
// with probability --follow (so its mistakes are visited), the teacher otherwise, and always the
// teacher when the student's action is invalid or unsafe.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { createConnection } from '@playwright/mcp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { plannerRequest, actorRequest, evaluatorRequest } from '../contract.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((p, v, i, all) => { if (v.startsWith('--')) p.push([v.slice(2), all[i + 1]]); return p }, []))
const worker = Number(args.worker ?? 0), workers = Number(args.workers ?? 1)
const FOLLOW = Number(args.follow ?? 0.6), MAX_STEPS = Number(args['max-steps'] ?? 25)
const out = args.out
const tasks = JSON.parse(readFileSync(args.tasks, 'utf8')).filter((t) => (t.split ?? 'train') === 'train').filter((_, i) => i % workers === worker)
mkdirSync(join(out, 'images'), { recursive: true })
const files = Object.fromEntries(['actor', 'evaluator', 'episodes'].map((k) => [k, join(out, `${k}-w${worker}.jsonl`)]))
const write = (file, row) => appendFileSync(file, JSON.stringify(row) + '\n')
const UNSAFE = /\b(pay|place order|buy now|add to (cart|bag)|checkout|send|post|create post|publish|tweet|reply|delete|remove|sign ?in|log ?in|sign ?up|submit|subscribe|confirm|book now|reserve)\b/i
const REF_LINE = /^(\s*)- '?(\w+)(?: "((?:[^"\\]|\\.)*)")?.*?\[ref=((?:f\d+)?e\d+)\]/
const VW = 1440, VH = 900
let rngState = (worker + 1) * 2654435761
const rand = () => ((rngState = (rngState * 1103515245 + 12345) >>> 0) / 4294967296)

// ---------- models ----------
async function chat(url, body, timeoutMs = 120000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal })
    const j = await res.json()
    return (j.choices?.[0]?.message?.content ?? '').replace(/<\/?think>/g, '').trim()
  } catch { return '' } finally { clearTimeout(t) }
}
const parts = (request, image) => {
  const [a, ...b] = request.split('<image>')
  return image ? [{ type: 'text', text: a }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image.toString('base64')}` } }, { type: 'text', text: b.join('<image>') }] : request
}
const student = (base, request, image, maxTokens = 48) => chat(`${base}/v1/chat/completions`, { messages: [{ role: 'user', content: parts(request, image) }], temperature: 0, max_tokens: maxTokens, cache_prompt: true })
const firstLine = (t) => t.split('\n').find((l) => l.trim())?.trim() ?? ''

const ACTOR_SYS = `You are the expert actor of a web agent. You get the goal, the plan with the current step [>], past actions, a screenshot and the accessibility tree (refs like [ref=e42]).
Reply with exactly ONE next action on one line, nothing else. Use a ref from the tree:
click(ref) | type(ref,"text") | select(ref,"option") | check(ref) | press("Enter") | scroll_down() | scroll_up() | back() | wait(2000)
Rules: this is a read-only task: never click buy, pay, send, post, submit, sign in, subscribe or similar. If the last actions repeated with no progress, choose a DIFFERENT way forward.`
const EVAL_SYS = `You are the expert evaluator of a web agent. You get the goal, plan, past actions, the last action, a screenshot and the accessibility tree.
Reply with exactly ONE verdict on one line, nothing else:
continue(n) — keep going, the current plan step number n
success("answer") — the goal is met; the answer must be COMPLETE and specific, copied from the page (all names, prices, numbers the goal asks for)
fail("reason") — impossible here
replan("reason") — the plan no longer fits the page or the agent is stuck repeating itself
takeover("reason") — a human must act (login, payment, captcha, or a step that would change something for real)`
const teacher = (sys, request, image) => chat(`${args.teacher.replace(/\/$/, '')}/chat/completions`, { model: args['teacher-model'] ?? 'qwen38', temperature: 0, max_tokens: 200, messages: [{ role: 'system', content: sys }, { role: 'user', content: parts(request, image) }], chat_template_kwargs: { enable_thinking: false } }, 180000)

function parsePlan(text, firstNumber = 1) {
  const steps = []
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*?)(?:\s*\|\s*check:\s*(.*))?$/)
    if (m && Number(m[1]) >= firstNumber) steps.push({ title: m[2].trim(), check: (m[3] ?? '').trim() })
  }
  return steps
}
function parseCall(action) {
  const m = action.match(/^(\w+)\((.*)\)$/s)
  if (!m) return null
  try { return { name: m[1], parts: m[2] ? JSON.parse(`[${m[2].replace(/(^|,)\s*((?:f\d+)?e\d+)\s*(?=,|$)/g, '$1"$2"')}]`) : [] } } catch { return null }
}
const canon = (a) => a.replace(/ref\s*=\s*/g, '').replace(/,\s+/g, ',').trim()

// ---------- browser ----------
const port = 9900 + worker
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: false, args: [`--remote-debugging-port=${port}`, '--disable-blink-features=AutomationControlled', `--window-size=${VW},${VH + 100}`] })
const context = await browser.newContext({ viewport: { width: VW, height: VH }, locale: 'en-IN', timezoneId: 'Asia/Kolkata' })
const page = await context.newPage()
const pw = await createConnection({ browser: { browserName: 'chromium', cdpEndpoint: `http://127.0.0.1:${port}` }, capabilities: ['core', 'core-navigation', 'core-tabs', 'core-input'], imageResponses: 'omit', snapshot: { mode: 'none', boxes: false }, timeouts: { action: 10_000, navigation: 45_000, settle: 350 } })
const client = new Client({ name: 'ogad-dagger', version: '1' })
{ const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([pw.connect(b), client.connect(a)]) }
const tool = async (name, a) => { const r = await client.callTool({ name, arguments: a }); const text = (r.content ?? []).map((p) => p.text ?? '').join('\n'); return { text, isError: Boolean(r.isError) || text.startsWith('### Error') } }
let shot = 0
async function observe(id) {
  await new Promise((r) => setTimeout(r, 800))
  const snapshot = (await tool('browser_snapshot', { boxes: false })).text
  const boxed = (await tool('browser_snapshot', { boxes: true })).text
  const imageRel = `images/${id}-${shot++}.jpg`
  const image = await page.screenshot({ type: 'jpeg', quality: 65, path: join(out, imageRel) }).catch(() => null)
  return { snapshot, boxed, image, imageRel }
}
const elementOf = (snapshot, ref) => snapshot.split('\n').map((l) => l.match(REF_LINE)).find((m) => m?.[4] === ref)
async function execute(call, snapshot) {
  const ref = typeof call.parts[0] === 'string' && /^(?:f\d+)?e\d+$/.test(call.parts[0]) ? call.parts[0] : null
  const el = ref ? elementOf(snapshot, ref) : null
  if (ref && !el) return 'error stale_ref'
  const element = el ? `${el[2]} "${el[3] ?? ''}"` : undefined
  const ok = (r) => (r.isError ? `error ${r.text.replace(/\s+/g, ' ').slice(0, 80)}` : 'ok')
  switch (call.name) {
    case 'click': case 'check': case 'uncheck': return ok(await tool('browser_click', { element, target: ref }))
    case 'type': return ok(await tool('browser_type', { element, target: ref, text: String(call.parts[1] ?? ''), submit: false, slowly: false }))
    case 'select': return ok(await tool('browser_select_option', { element, target: ref, values: [String(call.parts[1])] }))
    case 'press': return ok(await tool('browser_press_key', { key: String(call.parts[0]) }))
    case 'scroll_down': case 'scroll_up': return ok(await tool('browser_evaluate', { function: `() => { window.scrollBy(0, ${call.name === 'scroll_up' ? '-' : ''}Math.round(innerHeight * 0.8)); return 'ok' }` }))
    case 'back': return ok(await tool('browser_navigate_back', {}))
    case 'wait': await new Promise((r) => setTimeout(r, Math.min(Number(call.parts[0]) || 2000, 6000))); return 'ok'
    default: return 'error unsupported'
  }
}
// A teacher action is kept only if it parses and its ref is on this screen with a fitting role.
function validAction(action, snapshot) {
  const call = parseCall(action)
  if (!call) return null
  const ref = call.parts[0]
  if (['click', 'check', 'uncheck', 'type', 'select'].includes(call.name)) {
    const el = elementOf(snapshot, ref)
    if (!el) return null
    if (UNSAFE.test(`${el[2]} ${el[3] ?? ''}`)) return null
    if (call.name === 'type' && !/textbox|searchbox|combobox|spinbutton/.test(el[2])) return null
  } else if (!['press', 'scroll_down', 'scroll_up', 'back', 'wait'].includes(call.name)) return null
  return call
}

// ---------- episodes ----------
async function runTask(t) {
  const id = `dag-${t.id}`
  const stats = { steps: 0, rows: 0, followedStudent: 0, studentWrong: 0, unsafe: 0, loops: 0 }
  await tool('browser_navigate', { url: t.url }); await new Promise((r) => setTimeout(r, 2500))
  let obs = await observe(id)
  let plan = parsePlan(await student(args.planner, plannerRequest({ goal: t.goal, snapshot: obs.snapshot }), null, 400))
  if (!plan.length) plan = [{ title: t.goal, check: 'the goal is met' }]
  let marker = 1, last = 'task started', end = 'limit'
  const past = []
  for (let step = 0; step < MAX_STEPS; step++) {
    stats.steps++
    const view = { boxed: obs.boxed, width: VW, height: VH }
    // Evaluator row: the teacher's verdict on this screen.
    const evReq = evaluatorRequest({ goal: t.goal, plan, current: marker, past, last, snapshot: obs.snapshot })
    const tv = firstLine(await teacher(EVAL_SYS, evReq, obs.image))
    if (/^(continue\(\d+\)|success\(".+"\)|fail\(".*"\)|replan\(".*"\)|takeover\(".*"\))$/s.test(tv)) {
      write(files.evaluator, { id: `${id}:e${step}`, seed: id, family: 'recovery', request: evReq, image: obs.imageRel, response: tv }); stats.rows++
      const name = tv.split('(')[0]
      if (name === 'success' || name === 'fail' || name === 'takeover') { end = name; break }
      if (name === 'replan') {
        const done = plan.slice(0, marker - 1)
        const fresh = parsePlan(await student(args.planner, plannerRequest({ goal: t.goal, snapshot: obs.snapshot, done, reason: (tv.match(/"(.*)"/) ?? [])[1] ?? '' }), null, 400), done.length + 1)
        if (fresh.length) { plan = [...done, ...fresh]; marker = done.length + 1 }
      } else marker = Math.max(1, Math.min(plan.length, Number(tv.match(/\d+/)[0])))
    }
    // Actor rows: the teacher's action, in both views, for the screen the student reached.
    const aReq = actorRequest({ goal: t.goal, plan, current: marker, past, snapshot: obs.snapshot })
    const aReqView = actorRequest({ goal: t.goal, plan, current: marker, past, snapshot: obs.snapshot, view })
    const [sRaw, tRaw] = await Promise.all([student(args.actor, aReq, obs.image), teacher(ACTOR_SYS, aReq, obs.image)])
    const sAct = canon(firstLine(sRaw)), tAct = canon(firstLine(tRaw))
    const tCall = validAction(tAct, obs.snapshot)
    if (tCall) {
      write(files.actor, { id: `${id}:a${step}`, seed: id, family: 'recovery', request: aReq, image: obs.imageRel, response: tAct, accepted: [tAct], policy_action: sAct, policy_wrong: sAct !== tAct }); stats.rows++
      const ref = tCall.parts[0]
      if (typeof ref !== 'string' || aReqView.includes(`[ref=${ref}]`)) { write(files.actor, { id: `${id}:v${step}`, seed: id, family: 'recovery-view', request: aReqView, image: obs.imageRel, response: tAct, accepted: [tAct] }); stats.rows++ }
    }
    if (sAct !== tAct) stats.studentWrong++
    // Execute: the student's action (to visit its mistakes) unless invalid/unsafe; else the teacher's.
    const sCall = parseCall(sAct)
    const sEl = sCall && typeof sCall.parts[0] === 'string' ? elementOf(obs.snapshot, sCall.parts[0]) : null
    const sUnsafe = sEl && UNSAFE.test(`${sEl[2]} ${sEl[3] ?? ''}`)
    if (sUnsafe) stats.unsafe++
    const useStudent = sCall && !sUnsafe && rand() < FOLLOW
    const call = useStudent ? sCall : tCall
    if (!call) { end = 'no-action'; break }
    if (useStudent) stats.followedStudent++
    const before = obs.snapshot
    const result = await execute(call, obs.snapshot)
    obs = await observe(id)
    const action = useStudent ? sAct : tAct
    last = `${action} -> ${result === 'ok' ? (obs.snapshot !== before ? 'ok, page changed' : 'ok, no visible change') : result}`
    past.push(last)
    // Loop guard (as in the harness): 3 actions without progress force a re-plan.
    const recent = past.slice(-3)
    if (recent.length === 3 && (recent.every((x) => x.split(' -> ')[0] === recent[0].split(' -> ')[0]) || recent.every((x) => !/page changed/.test(x)))) {
      stats.loops++
      const done = plan.slice(0, marker - 1)
      const fresh = parsePlan(await student(args.planner, plannerRequest({ goal: t.goal, snapshot: obs.snapshot, done, reason: 'stuck: repeating actions with no progress' }), null, 400), done.length + 1)
      if (fresh.length) { plan = [...done, ...fresh]; marker = done.length + 1 }
      last = `${last}; stuck, plan changed`
    }
  }
  write(files.episodes, { seed: id, family: 'recovery', completed: true, end, ...stats, goal: t.goal, url: t.url })
  return { id, end, ...stats }
}

for (const t of tasks) {
  let r
  try { r = await runTask(t) } catch (e) { r = { id: t.id, end: 'crash', detail: String(e).slice(0, 120) } }
  console.log(JSON.stringify(r))
}
writeFileSync(join(out, `summary-w${worker}.json`), JSON.stringify({ done: true }))
await client.close(); await browser.close()
