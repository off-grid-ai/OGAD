import { setTimeout as delay } from 'node:timers/promises'
import sharp from 'sharp'
import type { WebContentsView } from 'electron'
import type { BrowserDriver } from './browser-driver'
import {
  AgentInterrupted,
  runAgentLoop,
  type AgentAction,
  type AgentActionOutcome,
  type AgentObservation,
  type AgentTarget,
  type AgentValue
} from '@offgrid/use'
import type { WebUseAgentModels } from '../../shared/web-use-settings'
import type { SemanticDecision } from './browser-playwright-policy'
import type { PlaywrightToolResult } from './playwright-mcp-session'
import {
  clickWithFallback,
  isPrivateSemanticTarget,
  projectPlaywrightPointer,
  safeWebUrl
} from './browser-playwright-actions'
import { observeUntilLoaded } from './browser-playwright-task'
import type {
  BrowserPlaywrightTaskInput,
  BrowserPlaywrightTaskResult,
  BrowserSemanticObservation
} from './browser-playwright-task-contract'
import {
  combinedSignal,
  compact,
  hasSemanticReferences,
  isUncertainActionTimeout,
  observeWithCurrentLease
} from './browser-playwright-task-support'
import { callBrowserAgentModel, type BrowserAgentRole } from './browser-agent-models'
import { benchTrace } from './web-use-bench-trace'
import { scoreWebLines, webRankerInstalled } from './web-ranker'
import { encodeTaskExecutionPlan, encodeTaskPhase } from '../../shared/task-execution-plan'

export interface BrowserAgentTaskInput extends BrowserPlaywrightTaskInput {
  /** The page as the models see it: a JPEG at the CSS viewport size (training: quality 70). */
  screenshot: () => Promise<Buffer>
  models: WebUseAgentModels
}

/** The snapshot line of one ref: `- textbox "Email" [ref=e15]`. Same pattern as capture.mjs. */
const REF_LINE = /^(\s*)- (.*?)\s*\[ref=((?:f\d+)?e\d+)\]/
/** wait_idle: reads of the page until two in a row match, at most this long. */
const IDLE_MS = 5_000
const IDLE_READ_MS = 350
const MAX_WAIT_MS = 30_000

/**
 * Web Use with the planner_actor_evaluator strategy (docs/MODEL_CONTRACT.md). The loop itself is
 * @offgrid/use runAgentLoop; this file gives it the in-app browser: Playwright MCP snapshots and
 * actions, page screenshots, the three model endpoints, and the shared input lease the user
 * takes over with.
 */
export async function runBrowserAgentTask(
  input: BrowserAgentTaskInput
): Promise<BrowserPlaywrightTaskResult> {
  try {
    return await runAgentTask(input)
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason ?? error
    const detail = error instanceof Error ? error.message : String(error)
    console.warn('[web-use][agent] loop failed', { error: compact(detail) })
    return {
      ok: false,
      fallback: false,
      summary: `Web Use stopped: ${compact(detail)}`,
      handoffs: 0
    }
  }
}

async function runAgentTask(input: BrowserAgentTaskInput): Promise<BrowserPlaywrightTaskResult> {
  const first = await observeUntilLoaded(input)
  if (first.isError || !hasSemanticReferences(first.text)) {
    return {
      ok: false,
      fallback: false,
      summary: first.isError
        ? `The page could not be read: ${compact(first.text)}`
        : 'The page did not expose usable semantic controls.',
      handoffs: 0
    }
  }
  let pending: PlaywrightToolResult | null = first
  let step = 0
  let seenEpoch = input.guard.currentActionLease().epoch

  const consentSeen = new Set<string>()
  const observe = async (): Promise<AgentObservation<Buffer>> => {
    let read = pending ?? (await observeWithCurrentLease(input))
    pending = null
    if (read.isError) throw new Error(`The page could not be read: ${compact(read.text)}`)
    if (await dismissConsent(input, read.text, consentSeen)) {
      const after = await observeWithCurrentLease(input)
      if (!after.isError) read = after
    }
    const image = await input.screenshot()
    if (benchTrace.current) benchTrace.current.finalPage = read.text
    await publish(input, { step, phase: 'checking', summary: `Step ${step}` })
    return {
      snapshot: read.text,
      image,
      url: pageUrl(read.text),
      scrollY: await scrollPosition(input)
    }
  }

  const model = async (
    role: BrowserAgentRole,
    request: string,
    image: Buffer | null
  ): Promise<string> => {
    input.onProgress(step, 'thinking', `Asking the ${role}`)
    const lease = input.guard.currentActionLease()
    const endpoint =
      role === 'answerer' ? (input.models.answerer ?? input.models.planner) : input.models[role]
    const startedAt = Date.now()
    const reply = await callBrowserAgentModel(
      role,
      endpoint,
      request,
      image,
      combinedSignal(input.signal, lease.signal)
    ).catch((error: unknown) => {
      // The user took control mid-call: the loop checks the take over next.
      if (lease.signal.aborted && !input.signal?.aborted) throw new AgentInterrupted()
      throw error
    })
    console.log('[web-use][agent] model reply', { role, reply: compact(reply) })
    benchTrace.current?.timings[role].push(Date.now() - startedAt)
    return reply
  }

  const userSaid = (): string => input.takeGuidance().join('; ')

  // The task's stages are the planner's plan: shown when made or re-made, and the current stage
  // moves with the evaluator. The task screen shows at most 7 stages; a longer plan shows its first 7.
  let shownPlan = ''
  let shownPhase = 0
  let planSize = 0
  const showPlan = (plan: readonly { title: string }[], current: number): void => {
    const phases = plan
      .slice(0, 7)
      .map((step, index) => ({ id: `phase-${index + 1}`, title: step.title }))
    planSize = phases.length
    const encoded = encodeTaskExecutionPlan({ version: 1, phases })
    if (encoded !== shownPlan) {
      shownPlan = encoded
      shownPhase = 0
      input.onStep(encoded)
    }
    const phase = Math.min(Math.max(current, 1), phases.length)
    if (phase > shownPhase) {
      shownPhase = phase
      input.onStep(encodeTaskPhase(`phase-${phase}`))
    }
  }

  // The ranked page view for the models set to read it, when the ranker is installed.
  const viewRoles = (['actor', 'evaluator'] as const).filter(
    (role) => input.models[role].rankedView
  )
  if (viewRoles.length && !webRankerInstalled()) {
    console.warn(
      '[web-use][agent] ranked page view set, but the web page ranker is not installed; using the 18k cut'
    )
  }
  const pageView =
    viewRoles.length && webRankerInstalled()
      ? {
          roles: viewRoles,
          score: async (query: string, units: readonly string[]) => {
            const startedAt = Date.now()
            const scores = await scoreWebLines(query, units)
            console.log('[web-use][agent] ranked page view', {
              lines: units.length,
              ms: Date.now() - startedAt
            })
            return scores
          }
        }
      : undefined
  const result = await runAgentLoop<Buffer>(
    { goal: input.goal },
    {
      observe,
      ...(pageView ? { pageView } : {}),
      planner: (request) => model('planner', request, null),
      actor: (request, image) => model('actor', request, image),
      evaluator: (request, image) => model('evaluator', request, image),
      // Without an answer model the evaluator's success text is the answer.
      ...(input.models.answerer
        ? { answerer: (request: string) => model('answerer', request, null) }
        : {}),
      execute: async (action, snapshot) => {
        step += 1
        input.onProgress(step, 'acting', action.line)
        const armed = await armReaction(input)
        const outcome = await executeAgentAction(input, action, snapshot)
        const reaction = armed ? await readReaction(input) : null
        benchTrace.current?.steps.push({
          action: action.line,
          result: outcome.isError ? compact(outcome.text) : 'ok',
          reaction: reaction?.summary ?? null
        })
        input.onStep(
          `${action.line}: ${outcome.isError ? compact(outcome.text) : reaction?.summary || 'done'}`
        )
        return reaction
          ? { ...outcome, changed: reaction.changed, reaction: reaction.summary }
          : outcome
      },
      handOff: async (why) => {
        input.onStep(`waiting for you: ${why}`)
        await input.waitForUser(why, input.signal)
        seenEpoch = input.guard.currentActionLease().epoch
        return userSaid()
      },
      userTookOver: async () => {
        await input.guard.waitUntilRunnable(input.signal)
        input.signal?.throwIfAborted()
        if (input.guard.isHalted) {
          throw new Error(input.guard.snapshot().reason || 'Task is no longer active')
        }
        const epoch = input.guard.currentActionLease().epoch
        if (epoch === seenEpoch) return null
        seenEpoch = epoch
        return userSaid()
      },
      onEvent: (event) => {
        if (event.type === 'plan') {
          console.log('[web-use][agent] plan', { steps: event.plan.length, current: event.current })
          if (benchTrace.current) benchTrace.current.plan = event.plan.map((s) => s.title)
          showPlan(event.plan, event.current)
        } else if (event.type === 'verdict') {
          console.log('[web-use][agent] verdict', event.verdict)
          benchTrace.current?.steps.push({ verdict: event.verdict })
        } else if (event.type === 'user') {
          input.onStep(event.entry)
        } else if (event.type === 'guard') {
          console.log('[web-use][agent] guard', event.text)
          benchTrace.current?.steps.push({ guard: event.text })
          input.onStep(event.text)
        }
      }
    }
  )
  // A finished task: every stage is done.
  if (result.outcome === 'success' && planSize > shownPhase)
    input.onStep(encodeTaskPhase(`phase-${planSize}`))
  if (benchTrace.current) {
    benchTrace.current.end =
      result.outcome === 'success' ? 'success' : result.outcome === 'fail' ? 'fail' : 'gave_up'
    benchTrace.current.detail =
      result.outcome === 'success' ? `success(${JSON.stringify(result.summary)})` : result.summary
  }
  if (result.outcome !== 'success') {
    if (result.outcome === 'fail') input.guard.fail(result.summary)
    return { ok: false, fallback: false, summary: result.summary, handoffs: result.handoffs }
  }
  // The evaluator saw the evidence; the shared owner still needs its verification observation.
  if (input.guard.beginVerification()) {
    await observeWithCurrentLease(input)
    await publish(input, { step, phase: 'complete', summary: result.summary })
    input.guard.complete()
  }
  input.onStep(`verified: ${result.summary}`)
  return { ok: true, fallback: false, summary: result.summary, handoffs: result.handoffs }
}

/**
 * The page as the training data has it (capture.mjs: page.screenshot, JPEG quality 70): the
 * viewport at CSS pixels, so a Retina capture is scaled down to the page's own size.
 */
export async function captureBrowserAgentFrame(
  view: WebContentsView,
  driver: BrowserDriver
): Promise<Buffer> {
  let png: Buffer
  try {
    png = (
      await view.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    ).toPNG()
  } catch (error) {
    if (!/current display surface not available for capture/i.test(String(error))) throw error
    png = await driver.captureScreenshot()
  }
  if (!png.length) png = await driver.captureScreenshot()
  const { width, height } = await driver.viewportSize()
  return sharp(png).resize({ width, height, fit: 'fill' }).jpeg({ quality: 70 }).toBuffer()
}

async function publish(
  input: BrowserPlaywrightTaskInput,
  observation: BrowserSemanticObservation
): Promise<void> {
  if (!input.onObservation) return
  try {
    await input.onObservation(observation)
  } catch (error) {
    input.onStep(
      `replay frame unavailable: ${compact(error instanceof Error ? error.message : String(error))}`
    )
  }
}

/**
 * A snapshot line without YAML quoting. Playwright quotes a line whose name has a colon:
 * `- 'checkbox "Mail from Notion: Trip" [ref=f3e12]'` reads as `- checkbox "…" [ref=f3e12]`.
 */
function plainLine(line: string): string {
  const quoted = /^(\s*- )'((?:[^']|'')*)'(:.*)?$/.exec(line)
  return quoted ? `${quoted[1]}${(quoted[2] ?? '').replaceAll("''", "'")}${quoted[3] ?? ''}` : line
}

function refLine(snapshot: string, ref: string): string | undefined {
  return snapshot
    .split('\n')
    .map(plainLine)
    .find((line) => REF_LINE.exec(line)?.[3] === ref)
}

/** A ref, or the first element whose snapshot line quotes the text. Points need vision. */
function resolveTarget(target: AgentTarget, snapshot: string): string | null {
  if (target.kind === 'ref') return target.ref
  if (target.kind === 'point') return null
  const quoted = JSON.stringify(target.text)
  for (const line of snapshot.split('\n').map(plainLine)) {
    const match = REF_LINE.exec(line)
    if (match && line.includes(quoted)) return match[3] ?? null
  }
  return null
}

function resolveValue(value: AgentValue | undefined, snapshot: string): string | null {
  return value && (value.kind === 'ref' || value.kind === 'point' || value.kind === 'text')
    ? resolveTarget(value, snapshot)
    : null
}

/** The decision shape the existing pointer and privacy checks read. */
function semanticDecision(
  action: SemanticDecision['action'],
  ref: string | null,
  snapshot: string,
  extra: Partial<SemanticDecision> = {}
): SemanticDecision {
  return {
    action,
    phase_id: null,
    element: ref ? (REF_LINE.exec(refLine(snapshot, ref) ?? '')?.[2] ?? ref) : null,
    ref,
    text: null,
    key: null,
    values: null,
    start_element: null,
    start_ref: null,
    end_element: null,
    end_ref: null,
    url: null,
    evidence_ref: null,
    evidence_text: null,
    reason: '',
    summary: '',
    ...extra
  }
}

const KEY_NAMES: Readonly<Record<string, string>> = {
  enter: 'Enter',
  tab: 'Tab',
  esc: 'Escape',
  escape: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  space: 'Space',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  ctrl: 'Control',
  shift: 'Shift',
  alt: 'Alt'
}

/** A vocabulary key (`enter`, `cmd+c`, or Playwright's own `Enter`) as a Playwright key. */
export function playwrightKey(key: string): string {
  return key
    .split('+')
    .map((part) => {
      const lower = part.toLowerCase()
      if (lower === 'cmd') return process.platform === 'darwin' ? 'Meta' : 'Control'
      if (/^f([1-9]|1[0-2])$/.test(lower)) return lower.toUpperCase()
      return KEY_NAMES[lower] ?? part
    })
    .join('+')
}

/**
 * One vocabulary action through Playwright MCP, as scripts/action-data/capture.mjs execute()
 * runs it for the training data. Playwright MCP settles 350 ms after each action.
 */
async function executeAgentAction(
  input: BrowserAgentTaskInput,
  action: AgentAction,
  snapshot: string
): Promise<AgentActionOutcome> {
  const lease = input.guard.currentActionLease()
  if (!input.guard.canActuate(lease.epoch)) return { isError: true, text: 'the user has control' }
  const signal = combinedSignal(input.signal, lease.signal)
  const [first, second] = action.args
  const target = resolveValue(first, snapshot)
  const text = (value: AgentValue | undefined): string =>
    value && 'value' in value ? String(value.value) : ''
  const ref = (decision: SemanticDecision): { element: string; target: string } => ({
    element: decision.element ?? '',
    target: decision.ref ?? ''
  })

  const run = async (
    decision: SemanticDecision | null,
    call: () => Promise<PlaywrightToolResult>
  ): Promise<AgentActionOutcome> => {
    if (
      decision?.ref === null &&
      decision.action !== 'navigate' &&
      decision.action !== 'press_key'
    ) {
      return { isError: true, text: 'not_found target' }
    }
    if (decision && isPrivateSemanticTarget(decision, snapshot)) {
      return { isError: true, text: 'blocked sensitive_field' }
    }
    if (decision) await projectPlaywrightPointer(input.activeDriver(), decision, snapshot)
    if (!input.guard.canActuate(lease.epoch)) return { isError: true, text: 'the user has control' }
    input.guard.countStep()
    try {
      const result = await call()
      return { isError: result.isError, text: result.text }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (lease.signal.aborted) return { isError: true, text: 'the user took control' }
      if (decision && isUncertainActionTimeout(decision, message)) {
        return { isError: true, timeout: true, text: message }
      }
      return { isError: true, text: message }
    }
  }

  switch (action.name) {
    case 'click':
    case 'focus': {
      const decision = semanticDecision('click', target, snapshot)
      return run(decision, () => clickWithFallback(input.session, ref(decision), signal))
    }
    case 'check':
    case 'uncheck': {
      const decision = semanticDecision('click', target, snapshot)
      const checked = /\[checked\]/.test(refLine(snapshot, target ?? '') ?? '')
      if (target && checked === (action.name === 'check')) {
        return { isError: false, text: `already ${action.name}ed` }
      }
      return run(decision, () => clickWithFallback(input.session, ref(decision), signal))
    }
    case 'type':
    case 'clear': {
      if (action.name === 'type' && action.args.length === 1) {
        return { isError: true, text: 'unsupported type without a target' }
      }
      const value = action.name === 'clear' ? '' : text(second)
      const decision = semanticDecision('type', target, snapshot, { text: value })
      return run(decision, () =>
        input.session.call(
          'browser_type',
          { ...ref(decision), text: value, submit: false, slowly: false },
          signal
        )
      )
    }
    case 'select': {
      const decision = semanticDecision('select_option', target, snapshot, {
        values: [text(second)]
      })
      return run(decision, () =>
        input.session.call(
          'browser_select_option',
          { ...ref(decision), values: [text(second)] },
          signal
        )
      )
    }
    case 'move': {
      const decision = semanticDecision('hover', target, snapshot)
      return run(decision, () => input.session.call('browser_hover', ref(decision), signal))
    }
    case 'drag': {
      const end = resolveValue(second, snapshot)
      if (!end) return { isError: true, text: 'not_found target' }
      const decision = semanticDecision('drag', target, snapshot, {
        start_ref: target,
        end_ref: end
      })
      const endElement = semanticDecision('hover', end, snapshot).element ?? end
      return run(decision, () =>
        input.session.call(
          'browser_drag',
          { startElement: decision.element, startTarget: target, endElement, endTarget: end },
          signal
        )
      )
    }
    case 'press': {
      const key = playwrightKey(text(first))
      const decision = semanticDecision('press_key', null, snapshot, { key })
      return run(decision, () => input.session.call('browser_press_key', { key }, signal))
    }
    case 'goto': {
      let url: string
      try {
        url = safeWebUrl(text(first))
      } catch (error) {
        return { isError: true, text: error instanceof Error ? error.message : String(error) }
      }
      const decision = semanticDecision('navigate', null, snapshot, { url })
      return run(decision, () => input.session.call('browser_navigate', { url }, signal))
    }
    case 'back':
      return run(null, () => input.session.call('browser_navigate_back', {}, signal))
    case 'scroll_down':
    case 'scroll_up': {
      // Same as capture.mjs: 80% of the viewport, so the next screen overlaps the last.
      const sign = action.name === 'scroll_up' ? '-' : ''
      return run(null, () =>
        input.session.call(
          'browser_evaluate',
          {
            function: `() => { window.scrollBy(0, ${sign}Math.round(innerHeight * 0.8)); return 'scrolled' }`
          },
          signal
        )
      )
    }
    case 'wait': {
      await delay(Math.min(Math.max(Number(text(first)) || 0, 0), MAX_WAIT_MS), undefined, {
        signal
      })
      return { isError: false, text: 'ok' }
    }
    case 'wait_idle':
      return waitIdle(input, signal)
    default:
      return { isError: true, text: `unsupported ${action.name}` }
  }
}

/** Screen and network stop changing: two snapshot reads in a row match. */
async function waitIdle(
  input: BrowserAgentTaskInput,
  signal: AbortSignal
): Promise<AgentActionOutcome> {
  const deadline = Date.now() + IDLE_MS
  let previous = (await input.session.snapshot(signal)).text
  while (Date.now() < deadline) {
    await delay(IDLE_READ_MS, undefined, { signal })
    const next = (await input.session.snapshot(signal)).text
    if (next === previous) return { isError: false, text: 'ok' }
    previous = next
  }
  return { isError: true, timeout: true, text: 'wait_idle the page kept changing' }
}

// ---------- reaction recorder: did the page react to the action, and how ----------
// scripts/action-data/e2e/REACTION_SIGNALS.md lists the signals. The recorder starts in the page
// before an action and is read once the page is quiet: navigation, scroll and document growth,
// elements added or removed, dialogs / menus / listboxes / alerts, ARIA state changes, text
// changes (digits ignored, so timers do not count) and focus or value changes.

/** Installs the recorder on the page. False when the page could not take it (it is navigating). */
async function armReaction(input: BrowserAgentTaskInput): Promise<boolean> {
  const result = await input.session
    .call('browser_evaluate', { function: ARM_REACTION }, input.signal)
    .catch(() => null)
  return Boolean(result && !result.isError)
}

const ARM_REACTION = `() => {
  const old = window.__ogadReaction; if (old && old.observer) old.observer.disconnect()
  const overlay = /^(dialog|alertdialog|alert|status|menu|menubar|listbox|tooltip)$/
  const r = { url: location.href, scrollY: window.scrollY, height: document.documentElement.scrollHeight,
    focus: document.activeElement ? document.activeElement.tagName + '|' + (document.activeElement.id || '') : '',
    added: 0, removed: 0, states: 0, text: 0, noise: 0, overlays: [], submitted: false, last: Date.now() }
  const isOverlay = (n) => n.nodeType === 1 && (overlay.test(n.getAttribute('role') || '') || (n.tagName === 'DIALOG' && n.open) || n.getAttribute('aria-modal') === 'true')
  const name = (n) => (n.getAttribute('aria-label') || n.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40)
  r.observer = new MutationObserver((list) => {
    r.last = Date.now()
    for (const m of list) {
      if (m.type === 'childList') {
        r.added += m.addedNodes.length; r.removed += m.removedNodes.length
        for (const n of m.addedNodes) if (n.nodeType === 1) {
          if (isOverlay(n)) r.overlays.push((n.getAttribute('role') || 'dialog') + ' ' + name(n))
          else for (const c of n.querySelectorAll('[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[role=alert],[role=tooltip],dialog[open]')) r.overlays.push((c.getAttribute('role') || 'dialog') + ' ' + name(c))
        }
      } else if (m.type === 'attributes') {
        if (/^(aria-|open$|hidden$|disabled$|value$|checked$)/.test(m.attributeName)) {
          r.states += 1
          if (m.attributeName === 'open' || m.attributeName === 'aria-hidden' || m.attributeName === 'hidden') { if (isOverlay(m.target)) r.overlays.push((m.target.getAttribute('role') || 'dialog') + ' ' + name(m.target)) }
        } else r.noise += 1
      } else if (m.type === 'characterData') {
        if (String(m.oldValue || '').replace(/\\d/g, '') !== String(m.target.data || '').replace(/\\d/g, '')) r.text += 1
      }
    }
  })
  r.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true, characterDataOldValue: true })
  addEventListener('submit', () => { r.submitted = true; r.last = Date.now() }, { capture: true, once: true })
  addEventListener('input', () => { r.last = Date.now(); r.states += 1 }, { capture: true })
  window.__ogadReaction = r
  return 'armed'
}`

const READ_REACTION = `() => {
  const r = window.__ogadReaction
  if (!r) return JSON.stringify({ navigated: true })
  const focus = document.activeElement ? document.activeElement.tagName + '|' + (document.activeElement.id || '') : ''
  return JSON.stringify({ navigated: location.href !== r.url, scroll: window.scrollY - r.scrollY,
    grew: document.documentElement.scrollHeight - r.height, added: r.added, removed: r.removed, states: r.states,
    text: r.text, overlays: r.overlays.slice(0, 3), submitted: r.submitted, focus: focus !== r.focus, quietMs: Date.now() - r.last })
}`

interface Reaction {
  readonly changed: boolean
  readonly summary: string
}

/** Reads the recorder once the page is quiet (300 ms without a change, at most 3 s). */
async function readReaction(input: BrowserAgentTaskInput): Promise<Reaction | null> {
  const deadline = Date.now() + 3_000
  for (;;) {
    const result = await input.session
      .call('browser_evaluate', { function: READ_REACTION }, input.signal)
      .catch(() => null)
    if (!result || result.isError) return null
    const seen = evaluateResult(result.text) as {
      navigated?: boolean
      scroll?: number
      grew?: number
      added?: number
      removed?: number
      states?: number
      text?: number
      overlays?: string[]
      submitted?: boolean
      focus?: boolean
      quietMs?: number
    } | null
    if (!seen || typeof seen !== 'object') return null
    if ((seen.quietMs ?? 1_000) < 300 && Date.now() < deadline && !seen.navigated) {
      await delay(150, undefined, { signal: input.signal })
      continue
    }
    const parts: string[] = []
    if (seen.navigated) parts.push('new page')
    if (seen.overlays?.length) parts.push(`${seen.overlays[0]} opened`)
    if (seen.submitted) parts.push('form sent')
    if (Math.abs(seen.scroll ?? 0) > 50) parts.push(`scrolled ${Math.round(seen.scroll ?? 0)}px`)
    if ((seen.grew ?? 0) > 100) parts.push('more content loaded')
    if ((seen.added ?? 0) + (seen.removed ?? 0) > 0)
      parts.push(`${seen.added ?? 0} added, ${seen.removed ?? 0} removed`)
    if ((seen.states ?? 0) > 0) parts.push('state changed')
    if ((seen.text ?? 0) > 0) parts.push('text changed')
    if (seen.focus) parts.push('focus moved')
    return { changed: parts.length > 0, summary: parts.join(', ') || 'no reaction' }
  }
}

/**
 * The value a browser_evaluate function returned. Playwright MCP prints it JSON-encoded under
 * "### Result"; the recorder's functions return JSON text, so it is decoded twice.
 */
function evaluateResult(text: string): unknown {
  const section = /### Result\s*\n([\s\S]*?)(?:\n###|$)/.exec(text)?.[1]?.trim() ?? text.trim()
  try {
    let value: unknown = JSON.parse(section)
    if (typeof value === 'string') value = JSON.parse(value)
    return value
  } catch {
    return null
  }
}

/** The page address from the snapshot header ("- Page URL: …"). */
function pageUrl(snapshot: string): string {
  return /^- Page URL: (\S+)/m.exec(snapshot)?.[1] ?? ''
}

async function scrollPosition(input: BrowserAgentTaskInput): Promise<number> {
  const result = await input.session
    .call('browser_evaluate', { function: '() => String(window.scrollY)' }, input.signal)
    .catch(() => null)
  const value = Number(result && !result.isError ? evaluateResult(result.text) : 0)
  return Number.isFinite(value) ? value : 0
}

// ---------- cookie and consent banners: reject non-essential when offered, else accept ----------

const REJECT =
  /^(reject( all)?( cookies)?|decline( all)?|deny( all)?|refuse( all)?|only (necessary|essential)( cookies)?|(use )?(strictly )?necessary( cookies)? only|disagree)$/i
const ACCEPT =
  /^(accept( all)?( cookies)?|allow( all)?( cookies)?|i agree|agree( and continue)?|got it|i accept|ok(ay)?)$/i

/** Closes a cookie or consent banner once per site. True when it clicked a button. */
async function dismissConsent(
  input: BrowserAgentTaskInput,
  snapshot: string,
  seen: Set<string>
): Promise<boolean> {
  if (!/cookie|consent|gdpr|privacy preferences/i.test(snapshot)) return false
  let origin = ''
  try {
    origin = new URL(pageUrl(snapshot)).origin
  } catch {
    /* no URL in the header */
  }
  if (seen.has(origin)) return false
  const buttons = snapshot
    .split('\n')
    .map(plainLine)
    .map((line) => /^\s*- button "([^"]+)"[^\n]*\[ref=((?:f\d+)?e\d+)\]/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
  for (const [choice, pattern] of [
    ['reject', REJECT],
    ['accept', ACCEPT]
  ] as const) {
    const hit = buttons.find((m) => pattern.test((m[1] ?? '').trim()))
    if (!hit) continue
    seen.add(origin)
    const result = await clickWithFallback(
      input.session,
      { element: hit[1] ?? '', target: hit[2] ?? '' },
      input.signal
    ).catch(() => null)
    if (result && !result.isError) {
      input.onStep(`closed the cookie banner (${choice})`)
      return true
    }
  }
  return false
}
