/**
 * The task planner's pure core (the orchestrator's judgment half). The local
 * chat model is reliable at NARROW per-step decisions but flaky at JUDGMENT:
 * picking the right tool (open_url vs web_task), filling required args (the
 * start url), and sequencing multi-step / data-dependent tasks. So before the
 * reactive tool loop runs, ONE focused planning call decomposes the request into
 * an ordered plan of tool steps; the executor then runs each through the exact
 * same dispatch/gate/rails the loop uses.
 *
 * Everything here is Electron-free and unit-tested: the schema, the prompt, the
 * fail-closed parse, the contact-handle resolution, and the should-plan gate.
 * The llm call and the tool dispatch are injected in planner.ts / plan-executor.ts.
 */

export interface PlanBinding {
  /** The arg on THIS step to fill. */
  arg: string
  /** The earlier step (0-based) whose result supplies the value. */
  fromStep: number
  /** Which field of that result to read (e.g. 'phone', 'email'). */
  field: string
}

export interface PlanStep {
  tool: string
  args: Record<string, unknown>
  why: string
  bindings: PlanBinding[]
}

export interface Plan {
  steps: PlanStep[]
}

/** A tool the planner may route to (name + what it does), derived from the same
 *  schemas the reactive loop already builds - so a new tool is plannable with no
 *  planner change. */
export interface ToolCatalogEntry {
  name: string
  description: string
}

/** The grammar the planner is constrained to. `args`/`bindings` are open objects
 *  (per-tool args can't be pre-typed) - llama.cpp allows a generic object; the
 *  parse below validates. */
export const PLAN_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'task_plan',
    schema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string' },
              args: { type: 'object' },
              why: { type: 'string' },
              bindings: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    arg: { type: 'string' },
                    fromStep: { type: 'integer' },
                    field: { type: 'string' }
                  },
                  required: ['arg', 'fromStep', 'field']
                }
              }
            },
            required: ['tool', 'args']
          }
        }
      },
      required: ['steps']
    }
  }
} as const

/** Clear conversational openers - a question or chit-chat needs no plan, so we
 *  skip the planner call entirely and let normal chat answer. Conservative:
 *  returns false ONLY for obvious non-actions, true otherwise. */
export function shouldPlan(message: string): boolean {
  const m = message.trim().toLowerCase()
  if (m.length === 0) {
    return false
  }
  // A pure question ("what is…", "how do I…", "who…") ending in '?' and with no
  // action verb is conversational.
  const questionOpener = /^(what|why|how|who|when|where|which|is |are |can |could |do |does |did |should |would |will |tell me|explain|summar|define)/
  const actionVerb =
    /\b(open|play|watch|send|message|text|email|mail|call|search|find|book|order|buy|schedule|create|add|remind|set|post|share|check in|log in|sign in|navigate|go to|download|upload)\b/
  if (questionOpener.test(m) && !actionVerb.test(m)) {
    return false
  }
  return true
}

export function buildPlannerPrompt(
  goal: string,
  history: { role: string; content: string }[],
  catalog: ToolCatalogEntry[]
): string {
  const toolLines = catalog.map((t) => `- ${t.name}: ${t.description}`)
  const recent = history
    .slice(-4)
    .map((h) => `${h.role}: ${h.content}`)
    .join('\n')
  return [
    'You are the PLANNER for an on-device assistant. Turn the user request into an ordered plan of tool steps that, run in order, complete it. You do NOT run the tools - you only choose them and fill their arguments.',
    '',
    'Tools you can use:',
    ...toolLines,
    '',
    recent ? `Recent conversation:\n${recent}\n` : '',
    `User request: ${goal}`,
    '',
    'Rules:',
    "- A task on a WEBSITE - play or watch a video, search and click a result, log in, fill a form, check in, place an order, extract - is web_task; it runs inside Off Grid's own built-in browser. open_url ONLY opens a link or app scheme, no interaction, so 'play X on YouTube' or 'search Y and open the first result' is web_task, NOT open_url. A task in an installed desktop APP with no web version (a native-only app) is computer_task.",
    '- Fill EVERY required argument. For web_task always set the "url" to the site (e.g. https://youtube.com). Do not leave a required arg blank.',
    '- If a step needs a value produced by an earlier step (e.g. a phone number from contacts_search to message someone), add a binding: {"arg":"to","fromStep":0,"field":"phone"} and leave that arg out of args.',
    '- Keep the plan MINIMAL - one step when one tool does it; do not add steps that are not needed.',
    '- If the request is just conversation, a question, or something no tool can do, return {"steps":[]}.',
    'Reply with ONLY the JSON plan.'
  ]
    .filter(Boolean)
    .join('\n')
}

/** Fail-closed parse: keep only well-formed steps whose tool is real; drop the
 *  rest. A malformed plan yields an empty plan (the caller falls back to the
 *  reactive loop) rather than dispatching garbage. */
export function parsePlan(raw: string, knownToolNames: readonly string[]): Plan {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { steps: [] }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { steps: [] }
  }
  const rawSteps = (parsed as { steps?: unknown }).steps
  if (!Array.isArray(rawSteps)) {
    return { steps: [] }
  }
  const known = new Set(knownToolNames)
  const steps: PlanStep[] = []
  for (const s of rawSteps) {
    if (typeof s !== 'object' || s === null) {
      continue
    }
    const step = s as Record<string, unknown>
    const tool = typeof step.tool === 'string' ? step.tool : ''
    if (!known.has(tool)) {
      continue
    }
    const args =
      typeof step.args === 'object' && step.args !== null && !Array.isArray(step.args)
        ? (step.args as Record<string, unknown>)
        : {}
    const bindings: PlanBinding[] = Array.isArray(step.bindings)
      ? step.bindings
          .filter(
            (b): b is Record<string, unknown> =>
              typeof b === 'object' && b !== null && !Array.isArray(b)
          )
          .map((b) => ({
            arg: typeof b.arg === 'string' ? b.arg : '',
            fromStep: typeof b.fromStep === 'number' ? b.fromStep : -1,
            field: typeof b.field === 'string' ? b.field : ''
          }))
          .filter((b) => b.arg && b.field && b.fromStep >= 0)
      : []
    steps.push({ tool, args, why: typeof step.why === 'string' ? step.why : '', bindings })
  }
  return { steps }
}

/** Tools whose required `goal` arg IS the task and must never be blank - the
 *  rail drives that string. */
const GOAL_TOOLS = new Set(['web_task', 'computer_task'])

/** Deterministic backfill: a `web_task`/`computer_task` step whose `goal` the
 *  planner left empty gets the user's full request - so the rail always drives
 *  the real task, never a generic placeholder (the "Run a web task" bug). Keeps
 *  a goal the planner DID provide (it may have refined it). Pure. */
export function backfillGoals(plan: Plan, userRequest: string): Plan {
  return {
    steps: plan.steps.map((s) => {
      if (!GOAL_TOOLS.has(s.tool)) {
        return s
      }
      const provided = typeof s.args.goal === 'string' ? s.args.goal.trim() : ''
      return provided ? s : { ...s, args: { ...s.args, goal: userRequest } }
    })
  }
}

/** Web tools that reach a site in a browser - the wrong rail when the user
 *  named an app they actually have installed. */
const WEB_TOOLS = new Set(['web_task', 'open_url'])

/** Rail-per-surface guard: if the request names a RUNNING native app (Slack,
 *  Spotify, ...), a plan that routed to the WEBSITE (web_task/open_url) is
 *  redirected to driving the app directly with computer_task. A consecutive run
 *  of web steps (open_url -> web_task) collapses into ONE computer_task carrying
 *  the user's full request. Deterministic, so it holds no matter which model
 *  planned - the fix for "send a file on Slack" opening slack.com in the browser.
 *  nativeApp null (no running app named) leaves the plan untouched. Pure. */
export function preferNativeApp(plan: Plan, userRequest: string, nativeApp: string | null): Plan {
  if (!nativeApp) {
    return plan
  }
  const steps: PlanStep[] = []
  let lastWasRedirect = false
  for (const s of plan.steps) {
    if (!WEB_TOOLS.has(s.tool)) {
      steps.push(s)
      lastWasRedirect = false
      continue
    }
    if (lastWasRedirect) {
      continue // collapse a run of web steps into the single computer_task above
    }
    steps.push({
      tool: 'computer_task',
      args: { goal: userRequest },
      why: `${nativeApp} is installed - drive the app directly, not its website`,
      bindings: []
    })
    lastWasRedirect = true
  }
  return { steps }
}

/** Resolve a contact handle from contacts_search's result text (which is a
 *  JSON.stringify of the matches). Prefers the requested field, then phone, then
 *  email; null when nothing usable. Pure so the recipient-binding is tested. */
export function resolveContactHandle(resultText: string, field = 'phone'): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(resultText)
  } catch {
    return null
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { results?: unknown }).results)
      ? (parsed as { results: unknown[] }).results
      : []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) {
      continue
    }
    const rec = item as Record<string, unknown>
    const pick = (k: string): string | null => {
      // Contacts results use either singular ('phone') or plural ('phones').
      for (const key of [k, `${k}s`]) {
        const v = rec[key]
        if (typeof v === 'string' && v.trim()) {
          return v.trim()
        }
        if (Array.isArray(v) && typeof v[0] === 'string' && (v[0] as string).trim()) {
          return (v[0] as string).trim()
        }
      }
      return null
    }
    const preferred = pick(field) ?? pick('phone') ?? pick('email') ?? pick('handle')
    if (preferred) {
      return preferred
    }
  }
  return null
}
