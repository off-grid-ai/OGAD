/**
 * Web Use with the planner_actor_evaluator strategy, end to end: the real @offgrid/use loop, the real
 * action executor, reaction recorder, consent handling and guard. Fakes sit only at the two real
 * boundaries: the three model endpoints (an OpenAI-compatible HTTP server, as llama.cpp serves them)
 * and the browser (a small stateful page behind the Playwright MCP session interface).
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { decodeTaskExecutionPlan, decodeTaskPhase } from '../../../shared/task-execution-plan'
import type { WebUseAgentModels } from '../../../shared/web-use-settings'
import { VisionGuard } from '../../vision/vision-guard'
import { playwrightKey, runBrowserAgentTask } from '../browser-agent-task'
import { benchTrace } from '../web-use-bench-trace'
import type { PlaywrightToolResult, SemanticPageSession } from '../playwright-mcp-session'

// ---------- the browser boundary: a small account form with a cookie banner ----------

class AccountPage implements SemanticPageSession {
  url = 'https://shop.test/account'
  consent = true
  name = ''
  plan = ''
  agreed = false
  saved = false
  unreadable = false
  /** Only an accept choice in the cookie banner. */
  acceptOnly = false
  /** A ticking line: the page never settles, so wait_idle times out. */
  restless = false
  private ticks = 0
  private last = ''
  readonly calls: string[] = []

  async snapshot(): Promise<PlaywrightToolResult> {
    if (this.unreadable) return { text: 'Error: page crashed', isError: true }
    const lines = [
      ...(this.consent
        ? [
            '- dialog "We use cookies" [ref=e90]:',
            '  - text: We use cookies to improve the site',
            ...(this.acceptOnly ? [] : ['  - button "Reject all" [ref=e91]']),
            '  - button "Accept all" [ref=e92]'
          ]
        : []),
      ...(this.restless ? [`- text: updated ${(this.ticks += 1)} times`] : []),
      '- heading "Account" [level=1] [ref=e1]',
      `- textbox "Name" [ref=e2]${this.name ? `: ${this.name}` : ''}`,
      `- combobox "Plan" [ref=e3]${this.plan ? `: ${this.plan}` : ''}`,
      `- checkbox "Agree to terms"${this.agreed ? ' [checked]' : ''} [ref=e4]`,
      '- textbox "Password" [ref=e7]',
      '- link "Help" [ref=e6]',
      '- button "Save" [ref=e5]',
      ...(this.saved ? ['- text: Saved REF-9'] : [])
    ]
    return {
      text: `### Page state\n- Page URL: ${this.url}\n- Page Title: Account\n- Page Snapshot:\n${lines.join('\n')}`,
      isError: false
    }
  }

  async recoverPage(): Promise<PlaywrightToolResult> {
    return this.snapshot()
  }

  async call(name: string, args: Record<string, unknown>): Promise<PlaywrightToolResult> {
    const fn = typeof args.function === 'string' ? args.function : ''
    if (name === 'browser_evaluate') {
      // The reaction recorder and scroll reads (browser-agent-task.ts) run as page functions.
      if (fn.includes('MutationObserver')) return result('armed')
      if (fn.includes('JSON.stringify({ navigated')) {
        // What the recorder saw depends on the action: a link opens a page, a key opens a dialog,
        // a scroll moves and loads more; a hover leaves output the recorder cannot read.
        if (this.last.startsWith('browser_hover'))
          return { text: '### Result\nnot json', isError: false }
        const navigated = this.last.startsWith('browser_click') && this.last.includes('"e6"')
        const pressed = this.last.startsWith('browser_press_key')
        const scrolled = this.last === 'evaluate scroll down'
        return result(
          JSON.stringify({
            navigated,
            scroll: scrolled ? 640 : 0,
            grew: scrolled ? 400 : 0,
            added: 1,
            removed: navigated ? 2 : 0,
            states: 1,
            text: pressed ? 1 : 0,
            overlays: pressed ? ['dialog Confirm'] : [],
            submitted: this.saved,
            focus: true,
            quietMs: 500
          })
        )
      }
      if (fn.includes('window.scrollY')) return result('0')
      this.last = `evaluate ${fn.includes('scrollBy(0, -') ? 'scroll up' : 'scroll down'}`
      this.calls.push(this.last)
      return result('scrolled')
    }
    this.last = `${name} ${JSON.stringify(args)}`
    this.calls.push(this.last)
    const target = String(args.target ?? '')
    if (name === 'browser_click') {
      if (target === 'e91' || target === 'e92') this.consent = false
      if (target === 'e4') this.agreed = !this.agreed
      if (target === 'e5') this.saved = true
    }
    if (name === 'browser_type' && target === 'e2') this.name = String(args.text)
    if (name === 'browser_select_option' && target === 'e3') {
      this.plan = String((args.values as string[])[0])
    }
    return { text: 'ok', isError: false }
  }
}

const result = (value: string): PlaywrightToolResult => ({
  text: `### Result\n${JSON.stringify(value)}`,
  isError: false
})

// ---------- the model boundary: three llama.cpp-style chat endpoints ----------

interface ModelCall {
  model: string
  messages: Array<{ role: string; content: unknown }>
}

let server: Server
let baseUrl = ''
const calls: ModelCall[] = []
let reply: (
  call: ModelCall
) => string | { status: number } | { delayMs: number; text: string } = () => ''

const body = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let data = ''
    request.on('data', (chunk) => (data += chunk))
    request.on('end', () => resolve(data))
  })

let dataDir = ''

beforeAll(async () => {
  // No ranker in this data folder: a ranked page view falls back to the bounded cut.
  dataDir = mkdtempSync(join(tmpdir(), 'offgrid-agent-task-'))
  process.env.OFFGRID_DATA_DIR = dataDir
  process.env.OFFGRID_MODELS_DIR = join(dataDir, 'models')
  server = createServer(async (request, response) => {
    const call = JSON.parse(await body(request)) as ModelCall
    calls.push(call)
    let answer = reply(call)
    if (typeof answer !== 'string' && 'delayMs' in answer) {
      const { delayMs, text } = answer
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      answer = text
    }
    if (typeof answer !== 'string') {
      response.writeHead(answer.status).end('model unavailable')
      return
    }
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ choices: [{ message: { content: answer } }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(dataDir, { recursive: true, force: true })
})

afterEach(() => {
  calls.length = 0
  benchTrace.current = null
})

const PLAN =
  '1 Fill in the account form | check: text "Saved"\n2 Report the reference | check: text "REF-"'

function models(extra: Partial<WebUseAgentModels> = {}): WebUseAgentModels {
  return {
    planner: { baseUrl, model: 'planner', instructions: true },
    actor: { baseUrl, model: 'actor', rankedView: true },
    evaluator: { baseUrl, model: 'evaluator' },
    ...extra
  }
}

function run(
  page: AccountPage,
  agentModels: WebUseAgentModels,
  taskId: string,
  onObservation?: () => Promise<void>
): {
  steps: string[]
  waited: string[]
  guard: VisionGuard
  done: ReturnType<typeof runBrowserAgentTask>
} {
  const steps: string[] = []
  const waited: string[] = []
  const guard = new VisionGuard({ taskId, kind: 'web_use' })
  const done = runBrowserAgentTask({
    goal: 'Save the account form for Asha and report the reference',
    plan: { version: 1, phases: [] },
    session: page,
    guard,
    activeDriver: () => null,
    activeUrl: () => page.url,
    waitForUser: async (why) => void waited.push(why),
    takeGuidance: () => ['signed in'],
    onStep: (note) => void steps.push(note),
    onPhase: () => undefined,
    onProgress: () => undefined,
    screenshot: async () => Buffer.from('jpeg-bytes'),
    models: agentModels,
    ...(onObservation ? { onObservation } : {})
  })
  return { steps, waited, guard, done }
}

describe('Web Use with trained planner, actor and evaluator models', () => {
  it('runs the plan through every action the vocabulary has, then answers from the page', async () => {
    const page = new AccountPage()
    const actions = [
      'type(e2,"Asha")',
      'type(e7,"hunter2")', // a password field: the user's to type
      'select(e3,"Pro")',
      'check(e4)',
      'press("enter")',
      'scroll_down()',
      'scroll_up()',
      'move("Help")',
      'drag(e2,e6)',
      'wait(1)',
      'goto("file:///etc/passwd")', // not a web address
      'back()',
      'wait_idle()',
      'uncheck(e4)',
      'check(e4)',
      'clear(e2)',
      'focus(e2)'
    ]
    let evaluated = 0
    reply = (call) => {
      if (call.model === 'planner') return PLAN
      if (call.model === 'actor') return actions.shift() ?? 'click(e5)'
      // The answer must come from the page (the loop checks it against the final page).
      if (call.model === 'answerer') return 'Saved REF-9'
      evaluated += 1
      // First the evaluator hands the page to the user once; a general model may write before
      // its verdict, and the verdict that ends the reply counts.
      if (evaluated === 1) return 'takeover("Sign in to continue")'
      return page.saved ? 'The page shows the reference. success("REF-9")' : 'continue(1)'
    }
    benchTrace.current = {
      id: 'agent-1',
      goal: 'Save',
      url: page.url,
      steps: [],
      timings: { planner: [], actor: [], evaluator: [], answerer: [] }
    }
    const { steps, waited, guard, done } = run(
      page,
      models({ answerer: { baseUrl, model: 'answerer' } }),
      'agent-task-all-actions'
    )
    const outcome = await done

    expect(outcome).toMatchObject({ ok: true, summary: 'Saved REF-9' })
    expect(outcome.handoffs).toBe(1)
    expect(waited).toEqual(['Sign in to continue'])
    expect(guard.snapshot().status).toBe('completed')
    // The cookie banner is closed once, with its reject choice.
    expect(page.consent).toBe(false)
    expect(steps).toContain('closed the cookie banner (reject)')
    // The planner's plan is the task's stages, and every stage ends done.
    const shown = steps.map(decodeTaskExecutionPlan).find(Boolean)
    expect(shown?.phases.map((phase) => phase.title)).toEqual([
      'Fill in the account form',
      'Report the reference'
    ])
    expect(steps.map(decodeTaskPhase).filter(Boolean).at(-1)).toBe('phase-2')
    // Every vocabulary action reached the page as its Playwright tool, except the two refused.
    expect(page.calls).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^browser_type .*"Asha"/),
        expect.stringMatching(/^browser_select_option .*"Pro"/),
        'browser_press_key {"key":"Enter"}',
        'evaluate scroll down',
        'evaluate scroll up',
        expect.stringMatching(/^browser_hover .*"e6"/),
        expect.stringMatching(/^browser_drag .*"startTarget":"e2".*"endTarget":"e6"/),
        'browser_navigate_back {}',
        expect.stringMatching(/^browser_type .*"text":""/),
        expect.stringMatching(/^browser_click .*"e5"/)
      ])
    )
    expect(page.calls.join('\n')).not.toContain('hunter2')
    expect(page.calls.join('\n')).not.toContain('file:///etc/passwd')
    expect(steps).toContain('type(e7,"hunter2"): blocked sensitive_field')
    expect(steps.some((step) => step.startsWith('verified: Saved REF-9'))).toBe(true)
    // The planner is a general model here: it gets its role instructions first. The actor and
    // evaluator get the screenshot between the two halves of their request.
    const planner = calls.find((call) => call.model === 'planner')!
    expect(planner.messages.map((message) => message.role)).toEqual(['system', 'user'])
    const actor = calls.find((call) => call.model === 'actor')!
    expect(actor.messages).toHaveLength(1)
    expect(JSON.stringify(actor.messages[0]!.content)).toContain('data:image/jpeg;base64,')
    // The task list runner's record of the run.
    expect(benchTrace.current).toMatchObject({
      end: 'success',
      plan: ['Fill in the account form', 'Report the reference']
    })
    expect(benchTrace.current?.timings.actor.length).toBeGreaterThan(10)
  })

  it('ends with the evaluator verdict when the goal cannot be met', async () => {
    const page = new AccountPage()
    page.consent = false
    reply = (call) =>
      call.model === 'planner'
        ? PLAN
        : call.model === 'actor'
          ? 'click(e6)'
          : 'fail("The account form is locked")'
    benchTrace.current = {
      id: 'agent-fail',
      goal: 'Save',
      url: page.url,
      steps: [],
      timings: { planner: [], actor: [], evaluator: [], answerer: [] }
    }
    const { guard, done } = run(page, models(), 'agent-task-fail')
    const outcome = await done
    expect(outcome).toMatchObject({ ok: false, summary: 'The account form is locked' })
    expect(guard.snapshot().status).toBe('failed')
    expect(benchTrace.current).toMatchObject({ end: 'fail', detail: 'The account form is locked' })
  })

  it('stops with the reason when a model endpoint answers with an error', async () => {
    const page = new AccountPage()
    reply = () => ({ status: 503 })
    const { done } = run(page, models(), 'agent-task-model-down')
    const outcome = await done
    expect(outcome.ok).toBe(false)
    expect(outcome.summary).toMatch(/^Web Use stopped: The planner model at .* answered 503/)
  })

  it('reports refused targets, page reactions and a take over, and shows at most seven stages', async () => {
    const page = new AccountPage()
    page.acceptOnly = true
    page.restless = true
    const longPlan = Array.from(
      { length: 8 },
      (_, index) => `${index + 1} Part ${index + 1} of the form | check: text "Saved"`
    ).join('\n')
    const actions = [
      'click("Missing")', // no element quotes this text
      'type(e2,"Bo")',
      'type("Bo")', // no target
      'click(e6)', // the link opens a page
      'drag(e2,"Nowhere")', // no end element
      'press("ctrl+a")', // a dialog opens
      'scroll_down()', // the page moves and loads more
      'wait_idle()', // the page keeps ticking
      'move(e1)' // the recorder's output cannot be read
    ]
    let actorCalls = 0
    let guard: VisionGuard | null = null
    reply = (call) => {
      if (call.model === 'planner') return longPlan
      if (call.model === 'actor') {
        actorCalls += 1
        // The person takes control while the actor is thinking, then hands it back.
        if (actorCalls === 3 && guard) {
          guard.takeOver()
          setTimeout(() => guard?.resume(), 50)
          return { delayMs: 300, text: 'wait(1)' }
        }
        return actions.shift() ?? 'click(e5)'
      }
      return page.saved ? 'success("Saved REF-9")' : 'continue(1)'
    }
    let published = 0
    const started = run(page, models(), 'agent-task-edges', async () => {
      published += 1
      if (published === 1) throw new Error('replay store is full')
    })
    guard = started.guard
    const outcome = await started.done

    expect(outcome).toMatchObject({ ok: true, summary: 'Saved REF-9' })
    expect(started.steps).toContain('closed the cookie banner (accept)')
    expect(started.steps).toContain('replay frame unavailable: replay store is full')
    expect(started.steps).toContain('click("Missing"): not_found target')
    expect(started.steps).toContain('type("Bo"): unsupported type without a target')
    expect(started.steps).toContain('drag(e2,"Nowhere"): not_found target')
    expect(started.steps.some((step) => step.startsWith('click(e6): new page'))).toBe(true)
    expect(
      started.steps.some((step) => step.startsWith('press("ctrl+a"): dialog Confirm opened'))
    ).toBe(true)
    expect(
      started.steps.some((step) =>
        /^scroll_down\(\): .*scrolled 640px, more content loaded/.test(step)
      )
    ).toBe(true)
    expect(started.steps).toContain('wait_idle(): wait_idle the page kept changing')
    expect(started.steps).toContain('move(e1): done')
    // An eight-step plan shows its first seven as the task's stages.
    const shown = started.steps.map(decodeTaskExecutionPlan).find(Boolean)
    expect(shown?.phases).toHaveLength(7)
  }, 20_000)

  it('tries a dropped model connection again, then stops with the error', async () => {
    const page = new AccountPage()
    reply = () => PLAN
    const outcome = await run(
      page,
      models({ planner: { baseUrl: 'http://127.0.0.1:9/v1', model: 'planner' } }),
      'agent-task-unreachable'
    ).done
    expect(outcome.ok).toBe(false)
    expect(outcome.summary).toMatch(/^Web Use stopped: /)
    expect(calls).toHaveLength(0)
  }, 10_000)

  it('does not start on a page it cannot read', async () => {
    const page = new AccountPage()
    page.unreadable = true
    reply = () => PLAN
    const outcome = await run(page, models(), 'agent-task-unreadable').done
    expect(outcome).toMatchObject({
      ok: false,
      summary: expect.stringMatching(/could not be read/)
    })
    expect(calls).toHaveLength(0)
  })
})

describe('vocabulary keys as Playwright keys', () => {
  it('maps names, modifiers and function keys', () => {
    expect(playwrightKey('enter')).toBe('Enter')
    expect(playwrightKey('shift+tab')).toBe('Shift+Tab')
    expect(playwrightKey('cmd+c')).toBe(process.platform === 'darwin' ? 'Meta+c' : 'Control+c')
    expect(playwrightKey('f5')).toBe('F5')
    expect(playwrightKey('Escape')).toBe('Escape')
  })
})
