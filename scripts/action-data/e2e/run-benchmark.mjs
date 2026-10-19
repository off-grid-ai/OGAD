// End-to-end benchmark runner: the planner / actor / evaluator loop from docs/MODEL_CONTRACT.md on
// live sites, with the models served by local llama.cpp servers. Requests are built with
// contract.mjs, so they match the training data and OGAD's harness byte for byte.
//
//   node run-benchmark.mjs --tasks tasks-v0.json --out results/r1 \
//     --planner http://127.0.0.1:8091 --actor http://127.0.0.1:8092 --evaluator http://127.0.0.1:8093
//     [--answer planner]   on success, the planner writes the answer from the final page
//
// Safety: the harness never clicks or types into a control whose name looks like pay, send, post,
// delete, buy or sign in unless the evaluator already handed over; it stops and records takeover.
// Clone tasks ({ app, kind, seed }: a held-out clone-farm app) are the exception: writes run only on
// *.farm.test, the app is reset and logged in first, and the app's own database decides the pass.
// Run them with --workers 1 (one app database).
//
// Harness v2 switches (--harness v2 turns on all but --mark-offscreen, --smart-change and --dismiss-consent;
// --harness v2.1 adds those two; each can be set alone with 1/0):
//   --skip-dead-frames  an iframe whose click timed out is removed from later snapshots (ads, embeds)
//   --no-repeat-fail    an action that already failed is not run again; the actor is asked once more,
//                       then the planner re-plans
//   --strict-success    a success counts only if its answer is backed by the page (numbers and most words
//                       on it) and, for questions, is not a description of what the agent did; after 3
//                       rejections the run ends as an honest failure
//   --view-url <url>    actor and evaluator read the ranked page view (train/pageview_server.py) of the
//                       full page instead of the 18k cut; --view-budget (default 4000);
//                       --view-roles actor (or evaluator) gives the view to that model only
//   --mark-offscreen    off-screen lines get [offscreen] in the ranked view (needs --view-url)
//   --settle            wait for the page to finish loading after each action (cap 5 s), not a fixed 0.8 s
//   --no-think          ask the servers for the non-thinking prompt the models were trained with
//   --answer-url <url>  the model for the answer step (default: --planner), e.g. the answer-trained planner
//   --smart-change      "the page changed" means a new URL, a scroll, the acted-on element's line changing, a
//                       dialog / alert / menu / listbox / tooltip / status line appearing or going, an element's
//                       expanded / checked / selected / pressed state changing, or 3+ other lines changing
//                       (refs and cursor marks removed, digits ignored, so timers and counters do not count);
//                       a loop is the same action on the same page state seen twice, or 3 actions with no change
//   --dismiss-consent   close cookie and consent banners, choosing "reject" when offered, else "accept"

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { chromium } from 'playwright-core'
import { createConnection } from '@playwright/mcp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { plannerRequest, actorRequest, evaluatorRequest, answerRequest, successIsBacked, boundedSnapshot, stripBoxes } from '../contract.mjs'
import { createRng } from '../rng.mjs'
import { CLONE_HOST } from '../clones/tree.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((p, v, i, all) => { if (v.startsWith('--')) p.push([v.slice(2), all[i + 1]]); return p }, []))
const tasks = JSON.parse(readFileSync(args.tasks, 'utf8'))
const only = args.only ? new Set(args.only.split(',')) : null
// --worker/--workers shard the task list so several browsers run at once.
const W = Number(args.worker ?? 0), WS = Number(args.workers ?? 1)
const CDP = Number(args.cdp ?? 9701 + W)
const out = args.out
const MAX_ACTIONS = Number(args['max-actions'] ?? 40)
const MAX_REPLANS = 4
const UNSAFE = /\b(pay|place order|buy now|send|post|publish|tweet|delete|remove account|sign ?in|log ?in|submit|confirm booking|checkout)\b/i
const REF_LINE = /^(\s*)- '?(.*?)\s*\[ref=((?:f\d+)?e\d+)\]/
const V2 = args.harness === 'v2' || args.harness === 'v2.1'
const V21 = args.harness === 'v2.1'
const flag = (name, v2Default) => (args[name] !== undefined ? args[name] === '1' : V2 && v2Default)
const flag21 = (name) => (args[name] !== undefined ? args[name] === '1' : V21)
const SKIP_DEAD_FRAMES = flag('skip-dead-frames', true)
const NO_REPEAT_FAIL = flag('no-repeat-fail', true)
const STRICT_SUCCESS = flag('strict-success', true)
const SETTLE = flag('settle', true)
const MARK_OFFSCREEN = flag('mark-offscreen', false)
const NO_THINK = flag('no-think', true)
const SMART_CHANGE = flag21('smart-change')
const DISMISS_CONSENT = flag21('dismiss-consent')
const ANSWER_URL = args['answer-url'] ?? args.planner
const VIEW_URL = args['view-url'] ?? null
const VIEW_BUDGET = Number(args['view-budget'] ?? 4000)
const VIEW_ROLES = new Set((args['view-roles'] ?? 'actor,evaluator').split(','))
mkdirSync(out, { recursive: true })

// ---------- models ----------

async function chat(base, request, image, maxTokens) {
  const parts = request.split('<image>')
  const content = image
    ? [{ type: 'text', text: parts[0] }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image.toString('base64')}` } }, { type: 'text', text: parts.slice(1).join('<image>') }]
    : request
  const started = Date.now()
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content }], temperature: 0, max_tokens: maxTokens, cache_prompt: true, ...(NO_THINK ? { chat_template_kwargs: { enable_thinking: false } } : {}) })
  })
  const body = await res.json()
  const text = (body.choices?.[0]?.message?.content ?? '').replace(/<\/?think>/g, '').trim()
  return { text, ms: Date.now() - started, timings: body.timings ?? null }
}

// ---------- plan and reply parsing ----------

function parsePlan(text, firstNumber = 1) {
  const steps = []
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*?)(?:\s*\|\s*check:\s*(.*))?$/)
    if (m && Number(m[1]) >= firstNumber) steps.push({ title: m[2].trim(), check: (m[3] ?? '').trim() })
  }
  return steps
}

const firstLine = (text) => text.split('\n').find((l) => l.trim())?.trim() ?? ''

function parseCall(action) {
  const m = action.match(/^(\w+)\((.*)\)$/s)
  if (!m) return null
  try {
    const parts = m[2] ? JSON.parse(`[${m[2].replace(/(^|,)((?:f\d+)?e\d+)(?=,|$)/g, '$1"$2"')}]`) : []
    return { name: m[1], parts }
  } catch { return null }
}

// ---------- browser ----------

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: false, args: [`--remote-debugging-port=${CDP}`, '--disable-blink-features=AutomationControlled', '--window-size=1440,1000'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-IN', timezoneId: 'Asia/Kolkata' })
let page = await context.newPage()
const server = await createConnection({
  browser: { browserName: 'chromium', cdpEndpoint: `http://127.0.0.1:${CDP}` },
  capabilities: ['core', 'core-navigation', 'core-tabs', 'core-input'],
  imageResponses: 'omit', snapshot: { mode: 'none', boxes: false },
  timeouts: { action: 10_000, navigation: 45_000, settle: 350 } // OGAD's real settings
})
const client = new Client({ name: 'OGAD benchmark', version: '1' })
const [ct, st] = InMemoryTransport.createLinkedPair()
await Promise.all([server.connect(st), client.connect(ct)])
const tool = async (name, toolArgs) => {
  const r = await client.callTool({ name, arguments: toolArgs })
  const text = (r.content ?? []).map((p) => p.text ?? '').join('\n')
  return { text, isError: Boolean(r.isError) || text.startsWith('### Error') }
}
// Frames whose clicks timed out in this task (SKIP_DEAD_FRAMES): their lines are left out of snapshots.
let deadFrames = new Set()
function dropFrames(snapshot) {
  if (!deadFrames.size) return snapshot
  const out = []
  let skipIndent = -1
  for (const line of snapshot.split('\n')) {
    const indent = line.length - line.trimStart().length
    if (skipIndent >= 0 && indent > skipIndent) continue
    skipIndent = -1
    const m = line.match(/\[ref=(f\d+)e\d+\]/)
    if (m && deadFrames.has(m[1])) { skipIndent = indent; continue }
    out.push(line)
  }
  return out.join('\n')
}
const observe = async () => {
  // SETTLE: give a click or Enter time to start a navigation, then wait for that page to load (cap 5 s).
  await new Promise((r) => setTimeout(r, SETTLE ? 600 : 800))
  if (SETTLE) { await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {}); await new Promise((r) => setTimeout(r, 300)) }
  const raw = (await tool('browser_snapshot', { boxes: Boolean(VIEW_URL && MARK_OFFSCREEN) })).text
  const boxed = VIEW_URL && MARK_OFFSCREEN ? dropFrames(raw) : null
  const snapshot = boxed ? stripBoxes(boxed) : dropFrames(raw)
  const image = await page.screenshot({ type: 'jpeg', quality: 70 })
  const url = page.url()
  const scrollY = await page.evaluate(() => window.scrollY).catch(() => 0)
  return { snapshot, boxed, image, url, scrollY }
}
const lineFor = (snapshot, ref) => snapshot.split('\n').map((l) => l.match(REF_LINE)).find((m) => m?.[3] === ref)?.[2]

async function execute(call, snapshot) {
  const ref = typeof call.parts[0] === 'string' && /^(?:f\d+)?e\d+$/.test(call.parts[0]) ? call.parts[0] : null
  const element = ref ? (lineFor(snapshot, ref) ?? null) : null
  if (ref && !element) return { result: `error stale_ref ${ref}` }
  const onClone = (() => { try { return CLONE_HOST.test(new URL(page.url()).hostname) } catch { return false } })()
  if (element && !onClone && UNSAFE.test(element)) return { result: 'blocked', blocked: element }
  const ok = (r) => ({ result: r.isError ? `error ${r.text.replace(/\s+/g, ' ').slice(0, 100)}` : 'ok' })
  switch (call.name) {
    case 'click': case 'check': case 'uncheck': return ok(await tool('browser_click', { element, target: ref }))
    case 'type': return ok(await tool('browser_type', { element, target: ref, text: String(call.parts[1] ?? ''), submit: false, slowly: false }))
    case 'clear': return ok(await tool('browser_type', { element, target: ref, text: '', submit: false, slowly: false }))
    case 'select': return ok(await tool('browser_select_option', { element, target: ref, values: [String(call.parts[1])] }))
    case 'press': return ok(await tool('browser_press_key', { key: String(call.parts[0]) }))
    case 'scroll_down': case 'scroll_up': return ok(await tool('browser_evaluate', { function: `() => { window.scrollBy(0, ${call.name === 'scroll_up' ? '-' : ''}Math.round(innerHeight * 0.8)); return 'ok' }` }))
    case 'back': return ok(await tool('browser_navigate_back', {}))
    case 'goto': return ok(await tool('browser_navigate', { url: String(call.parts[0]) }))
    case 'wait': case 'wait_idle': await new Promise((r) => setTimeout(r, Math.min(Number(call.parts[0]) || 2000, 8000))); return { result: 'ok' }
    default: return { result: `error unsupported action ${call.name}` }
  }
}

// ---------- the loop ----------

// Ranked page view (VIEW_URL): the request's AX block becomes the full page in the same format (no 18k
// cut), and the page-view service cuts it to the lines that matter for the current step.
async function withView(request, obs, goal, focus, role) {
  if (!VIEW_URL || !VIEW_ROLES.has(role)) return request
  const [head] = request.split('\nAX:\n')
  const page = boundedSnapshot(obs.boxed ?? obs.snapshot, goal, focus, 1e9)
  // Training rows longer than the old 18k cut start with this note; the view keeps it, so add it the same way.
  const long = boundedSnapshot(obs.snapshot, goal, focus, 1e9).length > 18000
  const full = `${head}\nAX:\n${long ? '[Snapshot shortened. Lines about the goal, controls and their labels retained.]\n' : ''}${page}`
  try {
    const res = await fetch(`${VIEW_URL}/view`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request: full, budget: VIEW_BUDGET, viewport: obs.boxed ? { width: 1440, height: 900 } : null }) })
    return (await res.json()).request
  } catch { return request } // service down: fall back to today's view
}

// STRICT_SUCCESS: an answer counts when the page backs it. For a question, a description of the agent's
// own action ("Opened search results") is not an answer.
const ASKS = /\b(tell me|what|which|who|how (many|much)|find|name|list|price|when|where|report)\b/i
const SELF_REPORT = /^(i\s+)?(opened|clicked|searched|navigated|went|scrolled|typed|showing|displayed|viewed|search results|results for|the page (shows|is|has))\b/i
const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9₹$€.%]+/g, ' ').trim()
function answerBacked(goal, answer, snapshot) {
  const a = String(answer ?? '').trim()
  if (a.length < 2) return 'empty answer'
  if (ASKS.test(goal) && SELF_REPORT.test(a)) return 'describes an action, not an answer'
  const page = norm(snapshot)
  const raw = String(snapshot).replace(/(\d),(?=\d)/g, '$1')
  const nums = (a.replace(/(\d),(?=\d)/g, '$1').match(/\d+(\.\d+)?/g) ?? []).filter((x) => !raw.includes(x))
  if (nums.length) return `numbers not on the page: ${nums.slice(0, 3).join(', ')}`
  const words = norm(a).split(' ').filter((w) => w.length > 2)
  if (words.length && words.filter((w) => page.includes(w)).length / words.length < 0.6) return 'most words are not on the page'
  return null
}

// SMART_CHANGE: the page state as a set of lines without refs and cursor marks (refs renumber between
// snapshots) and with digits masked, so timers, counters and ad churn do not count as change.
const stateLines = (snapshot) => new Set(snapshot.split('\n').map((l) => l.replace(/\s*\[(ref|cursor|active)[^\]]*\]/g, '').replace(/\d/g, '#').trim()).filter(Boolean))
const OVERLAY = /^-? ?'?(dialog|alertdialog|alert|status|menu|menubar|listbox|tooltip)\b/
const STATE_MARK = /\[(expanded|checked|selected|pressed)[^\]]*\]/
function pageChanged(a, b) {
  const A = stateLines(a), B = stateLines(b)
  const diff = [...A].filter((l) => !B.has(l)).concat([...B].filter((l) => !A.has(l)))
  return diff.length >= 3 || diff.some((l) => OVERLAY.test(l) || STATE_MARK.test(l))
}
const stateKey = (obs) => { let h = 0; for (const l of [...stateLines(obs.snapshot)].sort().join('\n')) h = (h * 31 + l.charCodeAt(0)) | 0; return `${obs.url}#${Math.round(obs.scrollY / 200)}#${h}` }

// The acted-on element's own line changed (a typed value, a checked box): a change even on a big page.
function targetChanged(call, a, b) {
  const ref = typeof call?.parts?.[0] === 'string' && /^(?:f\d+)?e\d+$/.test(call.parts[0]) ? call.parts[0] : null
  if (!ref) return false
  const line = (t) => t.split('\n').find((l) => l.includes(`[ref=${ref}]`)) ?? null
  return line(a) !== line(b)
}

// DISMISS_CONSENT: cookie and consent banners block the page; reject non-essential when offered, else accept.
const REJECT = /^(reject( all)?( cookies)?|decline( all)?|deny( all)?|refuse( all)?|only (necessary|essential)( cookies)?|(use )?(strictly )?necessary( cookies)? only|disagree)$/i
const ACCEPT = /^(accept( all)?( cookies)?|allow( all)?( cookies)?|i agree|agree( and continue)?|got it|i accept|ok(ay)?)$/i
const consentSeen = new Set()
async function dismissConsent(obs, log) {
  if (!DISMISS_CONSENT || !/cookie|consent|gdpr|privacy preferences/i.test(obs.snapshot)) return false
  let origin = ''
  try { origin = new URL(obs.url).origin } catch { /* no URL: one entry for every page without one */ }
  if (consentSeen.has(origin)) return false
  for (const [name, re] of [['reject', REJECT], ['accept', ACCEPT]]) {
    const button = page.getByRole('button', { name: re }).first()
    if (await button.isVisible({ timeout: 300 }).catch(() => false)) {
      const ok = await button.click({ timeout: 2000 }).then(() => true).catch(() => false)
      if (ok) { consentSeen.add(origin); log.steps.push({ guard: `consent banner: chose ${name}` }); return true }
    }
  }
  return false
}

async function runTask(task) {
  const log = { id: task.id, goal: task.goal, url: task.url, steps: [], timings: { planner: [], actor: [], evaluator: [] } }
  const started = Date.now()
  deadFrames = new Set()
  const failed = new Set()
  let repeatReplans = 0
  let rejected = 0
  await tool('browser_navigate', { url: task.url })
  await new Promise((r) => setTimeout(r, 2500))
  let obs = await observe()
  if (await dismissConsent(obs, log)) obs = await observe()
  const seenStates = new Map()
  const planned = await chat(args.planner, plannerRequest({ goal: task.goal, snapshot: obs.snapshot }), null, 400)
  log.timings.planner.push(planned.ms)
  let plan = parsePlan(planned.text)
  if (!plan.length) plan = [{ title: task.goal, check: 'the goal is met' }]
  log.plan = plan.map((s) => s.title)
  let marker = 1
  let last = 'task started'
  const past = []
  let replans = 0
  for (let n = 0; n <= MAX_ACTIONS; n++) {
    const ev = await chat(args.evaluator, await withView(evaluatorRequest({ goal: task.goal, plan, current: marker, past, last, snapshot: obs.snapshot }), obs, task.goal, plan[marker - 1]?.title ?? '', 'evaluator'), obs.image, 48)
    log.timings.evaluator.push(ev.ms)
    const verdict = firstLine(ev.text)
    log.steps.push({ verdict })
    const name = verdict.split('(')[0]
    const actionsTaken = log.steps.filter((x) => x.action).length
    let successNote = null
    if (name === 'success' && !successIsBacked((verdict.match(/"(.*)"/s) ?? [])[1] ?? '', obs.snapshot, actionsTaken)) {
      log.steps.push({ guard: 'success not backed by the page; continuing' })
    } else if (name === 'success') {
      // With --answer planner the planner writes the complete answer from the final page.
      let answer = (verdict.match(/"(.*)"/s) ?? [])[1] ?? ''
      if (args.answer === 'planner') {
        const ans = await chat(ANSWER_URL, answerRequest({ goal: task.goal, snapshot: obs.snapshot }), null, 300)
        log.timings.planner.push(ans.ms)
        log.evaluatorAnswer = verdict
        answer = ans.text.replace(/^answer\((.*)\)$/s, '$1').replace(/^"|"$/g, '')
      }
      const why = STRICT_SUCCESS && !task.app ? answerBacked(task.goal, answer, obs.snapshot) : null
      if (!why) return finish(log, name, `success(${JSON.stringify(answer)})`, started)
      log.steps.push({ guard: `success rejected: ${why}`, answer })
      if (++rejected >= 3) return finish(log, 'gave_up', `success not backed by the page (${why})`, started)
      successNote = `not done yet: ${why}`
    } else if (name === 'fail' || name === 'takeover') return finish(log, name, verdict, started)
    if (name === 'replan') {
      if (++replans > MAX_REPLANS) return finish(log, 'gave_up', 'too many re-plans', started)
      const done = plan.slice(0, marker - 1)
      const re = await chat(args.planner, plannerRequest({ goal: task.goal, snapshot: obs.snapshot, done, reason: (verdict.match(/"(.*)"/) ?? [])[1] ?? '' }), null, 400)
      log.timings.planner.push(re.ms)
      const fresh = parsePlan(re.text, done.length + 1)
      plan = [...done, ...(fresh.length ? fresh : plan.slice(marker - 1))]
      marker = done.length + 1
    } else {
      const m = verdict.match(/^continue\((\d+)\)/)
      if (m) marker = Math.max(1, Math.min(plan.length, Number(m[1])))
    }
    if (n === MAX_ACTIONS) return finish(log, 'gave_up', 'action limit', started)
    if (successNote) past.push(successNote)
    const actorReq = async () => withView(actorRequest({ goal: task.goal, plan, current: marker, past, snapshot: obs.snapshot }), obs, task.goal, plan[marker - 1]?.title ?? '', 'actor')
    let act = await chat(args.actor, await actorReq(), obs.image, 48)
    log.timings.actor.push(act.ms)
    let action = firstLine(act.text)
    if (NO_REPEAT_FAIL && failed.has(action)) {
      // The same action already failed on this task: tell the actor and ask once more.
      past.push(`${action} -> not run: it already failed, choose a different action`)
      log.steps.push({ guard: `repeat of failed action blocked: ${action}` })
      act = await chat(args.actor, await actorReq(), obs.image, 48)
      log.timings.actor.push(act.ms)
      action = firstLine(act.text)
      if (failed.has(action)) {
        // Re-plans forced by a blocked repeat have their own cap, so they do not end the task early.
        if (++repeatReplans > 2 * MAX_REPLANS) return finish(log, 'gave_up', 'repeats a failed action', started)
        const done = plan.slice(0, marker - 1)
        const re = await chat(args.planner, plannerRequest({ goal: task.goal, snapshot: obs.snapshot, done, reason: `${action} failed; find another way` }), null, 400)
        log.timings.planner.push(re.ms)
        const fresh = parsePlan(re.text, done.length + 1)
        if (fresh.length) { plan = [...done, ...fresh]; marker = done.length + 1 }
        last = `${action} failed; plan changed`
        log.steps.push({ guard: 'repeat again; re-planned' })
        continue
      }
    }
    const call = parseCall(action)
    const before = obs
    const outcome = call ? await execute(call, obs.snapshot) : { result: 'error unparsable action' }
    if (outcome.blocked) { log.steps.push({ action, result: 'blocked by harness' }); return finish(log, 'takeover', `harness stopped at "${outcome.blocked}"`, started) }
    // Playwright prefixes main-page refs with a frame id too; only a child frame (an iframe) can be dropped.
    const mainFrame = (obs.snapshot.match(/\[ref=(f\d+)e\d+\]/) ?? [])[1]
    const frame = (String(call?.parts?.[0] ?? '').match(/^(f\d+)e\d+$/) ?? [])[1]
    if (SKIP_DEAD_FRAMES && /Timeout/i.test(outcome.result ?? '') && frame && frame !== mainFrame) deadFrames.add(frame)
    obs = await observe()
    if (await dismissConsent(obs, log)) obs = await observe()
    const changed = SMART_CHANGE
      ? obs.url !== before.url || Math.abs(obs.scrollY - before.scrollY) > 50 || pageChanged(before.snapshot, obs.snapshot) || targetChanged(call, before.snapshot, obs.snapshot)
      : obs.snapshot !== before.snapshot
    const pairKey = `${action}@${stateKey(before)}`
    seenStates.set(pairKey, (seenStates.get(pairKey) ?? 0) + 1)
    last = `${action} -> ${outcome.result === 'ok' ? (changed ? 'ok, page changed' : 'ok, no visible change') : outcome.result}`
    // Only a real error (timeout, stale ref, unparsable) marks an action as failed: a click with no visible
    // change can be legitimate (a tab, a toggle), and the loop guard already handles plain repeats.
    if (outcome.result !== 'ok' && !/^(scroll_|wait|press)/.test(action)) failed.add(action)
    past.push(last)
    log.steps.push({ action, result: last })
    // Loop detection: the same action 3 times, or 3 actions with no visible change, forces a re-plan.
    const recent = log.steps.filter((x) => x.action).slice(-3)
    const looping = SMART_CHANGE
      ? seenStates.get(pairKey) >= 2 || (recent.length === 3 && recent.every((x) => !/page changed/.test(x.result)))
      : recent.length === 3 && (recent.every((x) => x.action === recent[0].action) || recent.every((x) => !/page changed/.test(x.result)))
    if (looping) {
      if (++replans > MAX_REPLANS) return finish(log, 'gave_up', 'stuck in a loop', started)
      log.steps.push({ guard: `loop: ${recent[0].action}; re-planning` })
      const done = plan.slice(0, marker - 1)
      const re = await chat(args.planner, plannerRequest({ goal: task.goal, snapshot: obs.snapshot, done, reason: `stuck: repeating ${recent[0].action} with no progress` }), null, 400)
      log.timings.planner.push(re.ms)
      const fresh = parsePlan(re.text, done.length + 1)
      if (fresh.length) { plan = [...done, ...fresh]; marker = done.length + 1 }
      last = `${last}; stuck, plan changed`
    }
  }
  return finish(log, 'gave_up', 'action limit', started)
}

function finish(log, end, detail, started) {
  log.end = end
  log.detail = detail
  log.seconds = (Date.now() - started) / 1000
  const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null)
  log.avgMs = { planner: avg(log.timings.planner), actor: avg(log.timings.actor), evaluator: avg(log.timings.evaluator) }
  return log
}

const results = []
for (const [i, task] of tasks.entries()) {
  if (only && !only.has(task.id)) continue
  if (i % WS !== W) continue
  // A site can close the tab (or the browser drops it): start the next task on a fresh tab.
  if (page.isClosed()) page = context.pages().find((p) => !p.isClosed()) ?? await context.newPage()
  let log, spec
  try {
    if (task.app) {
      // A clone task: reset and log in, then the app module writes the goal from its seeded data.
      const app = (await import(`../clones/apps/${task.app}.mjs`)).default
      const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 })
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      await app.reset({ sh })
      await app.login({ page, sh, tool, sleep })
      spec = await app.tasks[task.kind]({ rng: createRng(`bench:${task.id}:${task.seed ?? 1}`), sh, page, tool, sleep })
      if (!spec) throw new Error('no task')
      task.goal = spec.goal
      task.url = `${app.origin}${spec.start ?? '/'}`
      log = await runTask(task)
      log.verified = await spec.verify({ sh, page, snapshot: (await observe()).snapshot }).catch(() => false)
    } else log = await runTask(task)
  } catch (error) { log = { id: task.id, end: 'crash', detail: String(error).slice(0, 200) } }
  // The final page, so the grader can check an answer against what the page showed (live sites change).
  log.finalPage = await observe().then((o) => o.snapshot).catch(() => '')
  log.expect = task.expect
  log.passedByRule = task.app ? log.verified === true : task.expect === 'takeover' ? log.end === 'takeover' : log.end === 'success'
  results.push(log)
  await page.screenshot({ path: join(out, `${task.id}-final.jpg`), type: 'jpeg', quality: 70 }).catch(() => {})
  writeFileSync(join(out, `${task.id}.json`), JSON.stringify(log, null, 2))
  console.log(JSON.stringify({ id: log.id, end: log.end, detail: log.detail, actions: log.steps?.filter((s) => s.action).length, seconds: log.seconds, avgMs: log.avgMs }))
}
writeFileSync(join(out, WS > 1 ? `summary-w${W}.json` : 'summary.json'), JSON.stringify({ tasks: results.length, passedByRule: results.filter((r) => r.passedByRule).length, results: results.map(({ id, end, detail, passedByRule, seconds, avgMs }) => ({ id, end, detail, passedByRule, seconds, avgMs })) }, null, 2))
await client.close()
await browser.close()
