// One capture worker. It opens generated pages in Chromium, observes them through the same
// Playwright MCP connection and settings that OGAD's Web Use uses, and runs the loop from
// docs/MODEL_CONTRACT.md: planner → (evaluator → actor → harness)*. The label script plays all
// three models; every action is run and its effect checked before its row is kept.
//
// node scripts/action-data/capture.mjs --worker 0 --episodes 50 --out outputs/action-data/run1

import { mkdirSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { createConnection } from '@playwright/mcp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { generatePage } from './page-gen.mjs'
import { generateTask, correctActions, initialPlan, verdict, replan } from './tasks.mjs'
import { FLOW_FAMILIES, generateFlow, flowPlan, flowVerdict, flowReplan, flowActions } from './flows.mjs'
import { plannerRequest, plannerResponse, actorRequest, evaluatorRequest, obviousAction, evaluateCheck, viewportSnapshot, stripBoxes, findResult, findRefs, targetText } from './contract.mjs'
import { createRng } from './rng.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]])
  return pairs
}, []))
const worker = Number(args.worker ?? 0)
const episodes = Number(args.episodes ?? 10)
const runSeed = args.seed ?? 'pilot'
const out = args.out ?? 'outputs/action-data/pilot'
// --family form or --family form:2,list:1 (weights). Empty: the generator's own mix.
const FAMILIES = (args.family || '').split(',').filter(Boolean).map((part) => {
  const [name, weight] = part.split(':')
  return { name, weight: Number(weight ?? 1) }
})
const port = 9400 + worker
const MAX_STEPS = 500
const NOISE = Number(args.noise ?? 0.12)
// OGAD waits 350 ms after each action. Generated pages change at once (a save takes 700 ms or
// more, so "Saving…" is still captured), so the wait changes nothing here and costs time. Use
// --settle 350 for real sites.
const SETTLE = Number(args.settle ?? 0)
const REF_LINE = /^(\s*)- (.*?)\s*\[ref=((?:f\d+)?e\d+)\]/
// Roles a label can target. Wrappers, text and headings never carry a data-gen-id target.
// Snapshot lines whose name has a colon are YAML-quoted: - 'checkbox "A: B" [ref=e1]'
const TARGET_ROLES = /^'?(textbox|searchbox|combobox|checkbox|radio|button|link|row|group|spinbutton|slider|switch|tab|menuitem|option)\b/
// On-policy mode: our actor (a llama.cpp server) picks the action on a share of steps; the label
// script still labels the correct action for every state the model reaches.
const POLICY = args.policy || null
const POLICY_RATE = Number(args['policy-rate'] ?? 0.7)
const FOLLOW_WRONG = Number(args['follow-wrong'] ?? 0.5)
const VIEWPORTS = [[1280, 800], [1440, 900], [1024, 768], [1600, 1000]]
// --view onscreen: contract v1. Actor and evaluator see viewportSnapshot (what is on screen plus one
// screen below) and the label script writes find("text") when the correct target is not shown.
// Default (no flag): contract v0, the 18k boundedSnapshot, unchanged.
const VIEW = args.view === 'onscreen'

mkdirSync(join(out, 'images'), { recursive: true })
const files = {
  actor: join(out, `actor-w${worker}.jsonl`),
  evaluator: join(out, `evaluator-w${worker}.jsonl`),
  planner: join(out, `planner-w${worker}.jsonl`),
  episodes: join(out, `episodes-w${worker}.jsonl`)
}
const write = (file, row) => appendFileSync(file, `${JSON.stringify(row)}\n`)

process.setMaxListeners(0)
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: [`--remote-debugging-port=${port}`]
})
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await context.newPage()
let current = null
await context.route('**/*', (route) => {
  const url = new URL(route.request().url())
  if (current && url.hostname === current.spec.domain && url.pathname === current.spec.path) {
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: current.html })
  }
  return route.fulfill({ status: 404, contentType: 'text/html', body: '<h1>Not found</h1>' })
})

// Same connection options as src/main/browser/playwright-mcp-session.ts, except settle (above).
const server = await createConnection({
  browser: { browserName: 'chromium', cdpEndpoint: `http://127.0.0.1:${port}` },
  capabilities: ['core', 'core-navigation', 'core-tabs', 'core-input'],
  imageResponses: 'omit',
  snapshot: { mode: 'none', boxes: false },
  timeouts: { action: 10_000, navigation: 45_000, settle: SETTLE }
})
const client = new Client({ name: 'Off Grid AI action-data', version: '1' })
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

async function tool(name, toolArgs) {
  const result = await client.callTool({ name, arguments: toolArgs })
  const text = (result.content ?? []).map((part) => part.text ?? '').join('\n')
  return { text, isError: Boolean(result.isError) || text.startsWith('### Error') }
}

const totals = { episodes: 0, completed: 0, actorRows: 0, evaluatorRows: 0, plannerRows: 0, actions: 0, verdicts: {}, families: {}, reasons: {} }
const started = Date.now()

for (let n = 0; n < episodes; n++) {
  const seed = `${runSeed}:w${worker}:e${n}`
  try {
    const result = await runEpisode(seed)
    totals.episodes++
    totals.families[result.family] = (totals.families[result.family] ?? 0) + 1
    if (result.completed) totals.completed++
    else totals.reasons[result.reason] = (totals.reasons[result.reason] ?? 0) + 1
    write(files.episodes, { seed, ...result })
  } catch (error) {
    totals.reasons.crash = (totals.reasons.crash ?? 0) + 1
    write(files.episodes, { seed, completed: false, reason: 'crash', error: String(error?.stack ?? error).slice(0, 600) })
    // A closed browser or a full disk fails every later task too: stop instead of logging empty tasks.
    if (/has been closed|system error -122|ENOSPC|EDQUOT/.test(String(error))) break
  }
}
writeFileSync(join(out, `summary-w${worker}.json`), JSON.stringify({ ...totals, seconds: (Date.now() - started) / 1000 }, null, 2))
await client.close()
await browser.close()

async function runEpisode(seed) {
  const rng = createRng(`${seed}:run`)
  const family = pickFamily(rng)
  let task
  if (FLOW_FAMILIES.includes(family)) {
    const flow = generateFlow(seed, family)
    current = { spec: flow.spec, html: flow.html }
    task = flow.task
  } else {
    current = generatePage(seed, family)
    task = generateTask(current.spec, seed)
  }
  const { spec } = current
  // Consumer flows and the older families share the loop; only the label script differs.
  const L = spec.flow
    ? { plan: () => flowPlan(task), verdict: (p, st) => flowVerdict(task, p, st), replan: (p, st) => flowReplan(task, p, st), actions: (st) => flowActions(spec, task, st) }
    : { plan: (st) => initialPlan(spec, task, st), verdict: (p, st) => verdict(spec, task, p, st), replan: (p, st) => replan(spec, task, p, st), actions: (st) => correctActions(spec, task, st) }
  const [width, height] = rng.pick(VIEWPORTS)
  await page.setViewportSize({ width, height })
  const url = `https://${spec.domain}${spec.path}`
  const nav = await tool('browser_navigate', { url })
  if (nav.isError) return { family: spec.family, completed: false, reason: 'navigate', actions: 0 }
  await page.waitForFunction(() => Boolean(window.__og))

  const refCache = new Map()
  const past = []
  let step = 0
  let obs = await observe(seed, step)
  let plan = L.plan(obs.state)
  write(files.planner, { id: `${seed}:plan0`, seed, kind: 'plan', request: plannerRequest({ goal: task.goal, snapshot: obs.snapshot }), response: plannerResponse(plan) })
  totals.plannerRows++
  let marker = 1
  let last = 'task started'
  let actions = 0

  let skipEvaluator = false
  // Refs named by the find results since the last other action: valid targets though not on screen.
  let foundRefs = new Set()
  const view = () => (VIEW ? { boxed: obs.boxed, ...obs.viewport } : undefined)
  while (actions < MAX_STEPS) {
    // The harness moves on by itself after an obvious step whose check is now met.
    if (skipEvaluator) {
      skipEvaluator = false
      const truth = L.verdict(plan, obs.state)
      if (truth.verdict === `continue(${marker + 1})`) {
        totals.skippedEvaluator = (totals.skippedEvaluator ?? 0) + 1
        marker += 1
        const genToRef = await resolveRefs(obs.snapshot, refCache)
        const r = await actorTurn(genToRef, 'continue')
        if (r) return r
        continue
      }
      totals.skipDisagree = (totals.skipDisagree ?? 0) + 1
    }
    // Evaluator: judge the current screen.
    const judged = L.verdict(plan, obs.state)
    const name = judged.verdict.split('(')[0]
    totals.verdicts[name] = (totals.verdicts[name] ?? 0) + 1
    write(files.evaluator, {
      id: `${seed}:e${step}`, seed, step, family: spec.family,
      request: evaluatorRequest({ goal: task.goal, plan, current: marker, past, last, snapshot: obs.snapshot, view: view() }),
      image: obs.image, response: judged.verdict
    })
    totals.evaluatorRows++
    if (name === 'success' || name === 'fail') return { family: spec.family, completed: true, end: judged.verdict, actions }
    if (name === 'takeover') {
      const did = await page.evaluate(() => window.__og.userResolve())
      await page.waitForTimeout(400)
      last = `user took over -> ${did}`
      obs = await observe(seed, ++step)
      continue
    }
    if (name === 'replan') {
      const { done, remaining } = L.replan(plan, obs.state)
      write(files.planner, {
        id: `${seed}:plan${step}`, seed, kind: 'replan',
        request: plannerRequest({ goal: task.goal, snapshot: obs.snapshot, done, reason: judged.reason }),
        response: plannerResponse(remaining, done.length + 1)
      })
      totals.plannerRows++
      plan = [...done, ...remaining]
      marker = done.length + 1
    } else {
      marker = judged.current
    }

    const genToRef = await resolveRefs(obs.snapshot, refCache)
    const r = await actorTurn(genToRef, name, judged.verdict)
    if (r) return r
  }
  return { family: spec.family, completed: false, reason: 'max-steps', actions }

  // Actor (or the harness, for an obvious step): one action, run and checked. Returns an episode
  // result when the episode must end, else nothing.
  async function actorTurn(genToRef, name, verdictText = '') {
    const wanted = L.actions(obs.state)
    let accepted = wanted.map((a) => toRefs(a, genToRef)).filter(Boolean)
    if (!accepted.length) return { family: spec.family, completed: false, reason: wanted.length ? 'unresolved-target' : 'no-action', actions, wanted, verdict: verdictText }
    const auto = obviousAction(plan[marker - 1], obs.snapshot)
    const autoOk = auto && accepted.some((a) => a.replace(/\*/g, '') === auto || a === auto)
    if (auto && !autoOk) totals.autoDisagree = (totals.autoDisagree ?? 0) + 1
    if (VIEW && !autoOk) accepted = onScreenLabels(accepted)
    const wrong = !auto && actions > 0 && name === 'continue' && rng.chance(NOISE) ? wrongAction(spec, task, genToRef, rng, accepted) : null
    const noisy = Boolean(wrong)
    let executed = autoOk ? auto : wrong ?? chooseAction(accepted, rng)
    if (autoOk) totals.skippedActor = (totals.skippedActor ?? 0) + 1
    let policy = null
    let followWrong = false
    if (POLICY && !autoOk && !noisy && rng.chance(POLICY_RATE)) {
      const request = actorRequest({ goal: task.goal, plan, current: marker, past, snapshot: obs.snapshot, view: view() })
      const action = await policyAction(request, obs.image)
      const right = matchesAccepted(action, accepted)
      policy = { action, right }
      totals.policySteps = (totals.policySteps ?? 0) + 1
      if (right) { totals.policyRight = (totals.policyRight ?? 0) + 1; executed = action }
      else if (/^\w+\((?:(?:f\d+)?e\d+)?.*\)$/.test(action) && obs.snapshot.includes(`[ref=${(action.match(/\(((?:f\d+)?e\d+)/) ?? [])[1]}]`) && rng.chance(FOLLOW_WRONG)) {
        // Run the model's own mistake: the next states teach recovery from it.
        followWrong = true
        executed = action
      }
    }
    if (!noisy && !autoOk) {
      write(files.actor, {
        id: `${seed}:a${step}`, seed, step, family: spec.family, viewport: [width, height],
        request: actorRequest({ goal: task.goal, plan, current: marker, past, snapshot: obs.snapshot, view: view() }),
        image: obs.image, response: followWrong ? chooseAction(accepted, rng) : executed, accepted,
        ...(policy ? { policy_action: policy.action, policy_wrong: !policy.right } : {})
      })
      totals.actorRows++
    }

    // Harness: run it and record the result.
    const outcome = await execute(executed, obs.snapshot)
    const before = obs
    obs = await observe(seed, ++step)
    actions++
    totals.actions++
    const isFind = executed.startsWith('find(')
    foundRefs = isFind ? new Set([...foundRefs, ...findRefs(outcome.text)]) : new Set()
    const result = outcome.isError
      ? `${outcome.timeout ? 'timeout' : 'error'} ${compact(outcome.text)}`
      : isFind ? outcome.text
      : obs.snapshot !== before.snapshot ? 'ok, page changed' : 'ok, no visible change'
    if (!noisy && !followWrong && !checkEffect(executed, before.state, obs.state, genToRef)) {
      return { family: spec.family, completed: false, reason: `check-failed:${executed.split('(')[0]}`, actions, detail: compact(outcome.text) }
    }
    last = `${executed} -> ${result}`
    past.push(last)
    // After a harness step whose check is now met, the harness skips the evaluator (not after the last step).
    if (autoOk && marker < plan.length && evaluateCheck(plan[marker - 1].check, obs.snapshot) === true) skipEvaluator = true
    return null
  }

  // Contract v1 labels: keep the actions whose targets the actor can see (on screen, or named by a
  // find). When none is shown, the label is find("<target name>") if that find returns the target,
  // else a scroll toward it.
  function onScreenLabels(accepted) {
    const shown = viewportSnapshot(obs.boxed, obs.viewport, plan[marker - 1]?.title ?? '', task.goal)
    const refsOf = (action) => action.match(/(?<=[(,])(?:f\d+)?e\d+(?=[,)])/g) ?? []
    const seen = (ref) => foundRefs.has(ref) || shown.includes(`[ref=${ref}]`)
    const visible = accepted.filter((a) => refsOf(a).every(seen))
    if (visible.length) return visible
    const ref = refsOf(accepted[0]).find((r) => !seen(r))
    const name = targetText(obs.snapshot, ref)
    if (name && findRefs(findResult(obs.snapshot, name)).includes(ref)) {
      totals.findSteps = (totals.findSteps ?? 0) + 1
      return [`find(${JSON.stringify(name)})`]
    }
    totals.scrollForView = (totals.scrollForView ?? 0) + 1
    const y = Number((obs.boxed.split('\n').find((l) => l.includes(`[ref=${ref}]`))?.match(/\[box=-?[\d.]+,(-?[\d.]+),/) ?? [])[1] ?? 1)
    return [y < 0 ? 'scroll_up()' : 'scroll_down()']
  }
}

function pickFamily(rng) {
  if (!FAMILIES.length) return undefined
  let roll = rng.next() * FAMILIES.reduce((sum, f) => sum + f.weight, 0)
  for (const f of FAMILIES) {
    roll -= f.weight
    if (roll < 0) return f.name
  }
  return FAMILIES.at(-1).name
}


async function policyAction(request, imagePath) {
  try {
    const parts = request.split('<image>')
    const image = readFileSync(join(out, imagePath)).toString('base64')
    const content = [{ type: 'text', text: parts[0] }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } }, { type: 'text', text: parts.slice(1).join('<image>') }]
    const res = await fetch(`${POLICY}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content }], temperature: 0, max_tokens: 48, cache_prompt: true }) })
    const body = await res.json()
    const text = (body.choices?.[0]?.message?.content ?? '').replace(/<\/?think>/g, '').trim()
    return text.split('\n').find((l) => l.trim())?.trim() ?? ''
  } catch { return '' }
}

function matchesAccepted(action, accepted) {
  return accepted.some((a) => {
  const rx = new RegExp('^' + a.split('*').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 's')
  return rx.test(action)
  })
}

async function observe(seed, step) {
  const state = await page.evaluate(() => window.__og.state())
  const image = `images/${safe(seed)}-s${step}.jpg`
  if (VIEW) {
    const boxed = (await tool('browser_snapshot', { boxes: true })).text
    await page.screenshot({ path: join(out, image), type: 'jpeg', quality: 70 })
    return { state, snapshot: stripBoxes(boxed), boxed, viewport: page.viewportSize(), image }
  }
  const snapshot = (await tool('browser_snapshot', { boxes: false })).text
  await page.screenshot({ path: join(out, image), type: 'jpeg', quality: 70 })
  return { state, snapshot, image }
}

// ---------- refs ----------

/**
 * Map data-gen-id → snapshot ref, asking the page only about target refs not seen before.
 * The lookups run in parallel, so any settle wait is paid once per step.
 */
async function resolveRefs(snapshot, cache) {
  const lines = snapshot.split('\n').map((line) => line.match(REF_LINE)).filter(Boolean)
  const fresh = lines.filter(([, , description, ref]) => !cache.has(ref) && TARGET_ROLES.test(description))
  await Promise.all(fresh.map(async ([, , description, ref]) => {
    const result = await tool('browser_evaluate', {
      element: description.slice(0, 80),
      target: ref,
      function: '(el) => (el && el.dataset && el.dataset.genId) || null'
    })
    const value = result.isError ? null : JSON.parse(result.text.match(/### Result\n(.*)/)?.[1] ?? 'null')
    cache.set(ref, { genId: value, description })
  }))
  const genToRef = new Map()
  for (const [, , description, ref] of lines) {
    const genId = cache.get(ref)?.genId
    if (genId && !genToRef.has(genId)) genToRef.set(genId, { ref, description })
  }
  return genToRef
}

/** `click(@f3)` → `click(e12)`. Null when the target is not in this snapshot. */
function toRefs(action, genToRef) {
  let missing = false
  const out = action.replace(/(?<=[(,])@([\w-]+)/g, (_, genId) => {
    const hit = genToRef.get(genId)
    if (!hit) missing = true
    return hit?.ref ?? ''
  })
  return missing ? null : out
}

// ---------- choosing and running actions ----------

function chooseAction(accepted, rng) {
  const pick = rng.chance(0.7) ? accepted[0] : rng.pick(accepted)
  return pick === 'wait(*)' ? `wait(${rng.pick([1000, 1500, 2000, 3000])})` : pick
}

/** A plausible wrong step: it teaches the evaluator to re-plan and gives recovery states. */
function wrongAction(spec, task, genToRef, rng, accepted) {
  if (spec.family === 'feed') {
    // Like a post the goal did not ask for: the evaluator must re-plan and the actor undo it.
    const wanted = new Set(task.steps.map((st) => st.action.id))
    const others = spec.posts.filter((p) => !wanted.has(p.likeId) && genToRef.has(p.likeId))
    return others.length ? `click(${genToRef.get(rng.pick(others).likeId).ref})` : null
  }
  if (spec.flow) return null
  const navs = spec.nav.filter((n) => genToRef.has(n.id))
  const targets = new Set((task.targets ?? []).map((t) => t.id))
  const fields = (spec.pages ?? []).flatMap((p) => p.sections.flatMap((s) => s.fields))
    .filter((f) => ['text', 'email', 'tel', 'number', 'textarea'].includes(f.kind) && !targets.has(f.id) && genToRef.has(f.id))
  const goalRefs = new Set(accepted.join(' ').match(/(?:f\d+)?e\d+/g) ?? [])
  const wrong = fields.filter((f) => !goalRefs.has(genToRef.get(f.id).ref))
  if (wrong.length && rng.chance(0.5)) return `type(${genToRef.get(rng.pick(wrong).id).ref},"test")`
  if (navs.length) return `click(${genToRef.get(rng.pick(navs).id).ref})`
  return null
}

function parseCall(action) {
  const [, name, body] = action.match(/^(\w+)\((.*)\)$/s)
  const parts = body ? JSON.parse(`[${body.replace(/(^|,)((?:f\d+)?e\d+)(?=,|$)/g, '$1"$2"')}]`) : []
  return { name, parts }
}

async function execute(action, snapshot) {
  const { name, parts } = parseCall(action)
  const element = (ref) => snapshot.split('\n').map((l) => l.match(REF_LINE)).find((m) => m?.[3] === ref)?.[2] ?? ref
  switch (name) {
    case 'click':
    case 'check':
    case 'uncheck':
      return tool('browser_click', { element: element(parts[0]), target: parts[0] })
    case 'type':
      return tool('browser_type', { element: element(parts[0]), target: parts[0], text: parts[1], submit: false, slowly: false })
    case 'clear':
      return tool('browser_type', { element: element(parts[0]), target: parts[0], text: '', submit: false, slowly: false })
    case 'select':
      return tool('browser_select_option', { element: element(parts[0]), target: parts[0], values: [parts[1]] })
    case 'drag':
      return tool('browser_drag', { startElement: element(parts[0]), startTarget: parts[0], endElement: element(parts[1]), endTarget: parts[1] })
    case 'press':
      return tool('browser_press_key', { key: parts[0] })
    case 'scroll_down':
    case 'scroll_up':
      return tool('browser_evaluate', { function: `() => { window.scrollBy(0, ${name === 'scroll_up' ? '-' : ''}Math.round(innerHeight * 0.8)); return 'scrolled' }` })
    case 'back':
      return tool('browser_navigate_back', {})
    case 'find':
      return { text: findResult(snapshot, parts[0]), isError: false }
    case 'wait':
    case 'wait_idle': {
      try {
        await page.waitForFunction(() => !window.__og.state().saving, null, { timeout: Math.max(Number(parts[0]) || 0, 5000) })
        await page.waitForTimeout(350)
        return { text: 'ok', isError: false }
      } catch {
        return { text: 'the page kept loading', isError: true, timeout: true }
      }
    }
    default:
      return { text: `unsupported action ${name}`, isError: true }
  }
}

/** The label is kept only if running it had the effect the label script expected. */
function checkEffect(action, before, after, genToRef) {
  const { name, parts } = parseCall(action)
  const refToGen = new Map([...genToRef].map(([genId, { ref }]) => [ref, genId]))
  const gid = parts[0] && refToGen.get(parts[0])
  const changed = JSON.stringify({ ...after, visible: null }) !== JSON.stringify({ ...before, visible: null }) || after.visible.join() !== before.visible.join()
  switch (name) {
    case 'type': return after.values[gid] === parts[1]
    case 'clear': return after.values[gid] === ''
    case 'select': return after.values[gid] === parts[1]
    case 'check': case 'uncheck': case 'click': {
      if (gid && /^f\d+-\d+$/.test(gid)) return after.values[gid.replace(/-\d+$/, '')] !== before.values[gid.replace(/-\d+$/, '')]
      if (gid && typeof after.values[gid] === 'boolean') return after.values[gid] !== before.values[gid]
      return changed
    }
    case 'press': case 'drag': return changed
    case 'scroll_down': case 'scroll_up': return after.scrollY !== before.scrollY || after.loaded !== before.loaded
    case 'back': return after.view !== before.view
    case 'find': return true
    case 'wait': case 'wait_idle': return !after.saving
    default: return false
  }
}

function compact(text) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 120)
}

function safe(text) {
  return text.replace(/[^\w-]+/g, '_')
}
