/**
 * The task planner's pure core (the orchestrator's judgment half). The local
 * chat model is reliable at NARROW per-step decisions but flaky at JUDGMENT:
 * picking the right tool (open_url vs web_use), filling required args (the
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

export type PlanParseResult =
  | { valid: true; plan: Plan }
  | { valid: false; plan: Plan; error: string }

/** A tool the planner may route to (name + what it does), derived from the same
 *  schemas the reactive loop already builds - so a new tool is plannable with no
 *  planner change. */
export interface ToolCatalogEntry {
  name: string
  description: string
}

/** The grammar the planner is constrained to. Provider strict-schema modes do
 * not allow an open object for per-tool arguments, so `args` is a JSON-encoded
 * object string. The parser below owns decoding and validation. */
export const PLAN_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'task_plan',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string' },
              args: {
                type: 'string',
                description: 'A JSON-encoded object containing the tool arguments.'
              },
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
                  required: ['arg', 'fromStep', 'field'],
                  additionalProperties: false
                }
              }
            },
            required: ['tool', 'args', 'why', 'bindings'],
            additionalProperties: false
          }
        }
      },
      required: ['steps'],
      additionalProperties: false
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
  const questionOpener =
    /^(what|why|how|who|when|where|which|is |are |can |could |do |does |did |should |would |will |tell me|explain|summar|define)/
  const actionVerb =
    /\b(open|play|watch|send|message|text|email|mail|call|search|find|book|order|buy|schedule|create|add|remind|set|post|share|check in|log in|sign in|navigate|go to|download|upload)\b/
  if (!actionVerb.test(m) && (questionOpener.test(m) || m.endsWith('?'))) {
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
    "- A task on a WEBSITE - play or watch a video, search and click a result, log in, fill a form, check in, place an order, extract - is web_use; it runs inside Off Grid AI's own built-in browser. open_url ONLY opens a link or app scheme, no interaction, so 'play X on YouTube' or 'search Y and open the first result' is web_use, NOT open_url. A task in an installed desktop APP with no web version (a native-only app) is computer_task.",
    '- Fill EVERY required argument. For web_use always set the "url" to the site (e.g. https://youtube.com). Do not leave a required arg blank.',
    '- The args field is a JSON-encoded object string. Example: {"tool":"web_use","args":"{\\"url\\":\\"https://youtube.com\\",\\"goal\\":\\"Find the requested video\\"}","why":"The task needs website interaction","bindings":[]}.',
    '- If a step needs a value produced by an earlier step (e.g. a phone number from contacts_search to message someone), add a binding: {"arg":"to","fromStep":0,"field":"phone"} and leave that value out of the JSON object encoded in args.',
    '- Keep the plan MINIMAL - one step when one tool does it; do not add steps that are not needed.',
    '- If the request is just conversation, a question, or something no tool can do, return {"steps":[]}.',
    'Reply with ONLY the JSON plan.'
  ]
    .filter(Boolean)
    .join('\n')
}

/** Keep the full original task context on the one repair attempt, then give the
 *  model the validator's exact failure. The model still owns the replacement
 *  plan; application code does not infer a tool from the user's wording. */
export function buildPlannerRetryPrompt(originalPrompt: string, validationError: string): string {
  return [
    originalPrompt,
    '',
    'Validation feedback:',
    `Your previous response was invalid: ${validationError}.`,
    'Return one complete plan that matches the required JSON schema. Return JSON only. Do not explain or narrate.'
  ].join('\n')
}

function invalidPlan(error: string): PlanParseResult {
  return { valid: false, plan: { steps: [] }, error }
}

/** Fail-closed parse with an explicit validity result. A valid conversational
 *  escape hatch (`{"steps":[]}`) is different from malformed model output;
 *  callers must not silently treat planner narration as a no-action decision. */
export function parsePlanResult(raw: string, knownToolNames: readonly string[]): PlanParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return invalidPlan('the planner response was not JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return invalidPlan('the planner response was not a JSON object')
  }
  const rawSteps = (parsed as { steps?: unknown }).steps
  if (!Array.isArray(rawSteps)) {
    return invalidPlan('the planner response did not contain a steps array')
  }
  const known = new Set(knownToolNames)
  const steps: PlanStep[] = []
  for (const [index, value] of rawSteps.entries()) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return invalidPlan(`planner step ${index + 1} was not an object`)
    }
    const step = value as Record<string, unknown>
    const tool = typeof step.tool === 'string' ? step.tool : ''
    if (!known.has(tool)) {
      return invalidPlan(`planner step ${index + 1} named an unavailable tool`)
    }
    let args: Record<string, unknown>
    if (typeof step.args === 'string') {
      try {
        const decoded = JSON.parse(step.args) as unknown
        if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
          return invalidPlan(`planner step ${index + 1} args did not decode to an object`)
        }
        args = decoded as Record<string, unknown>
      } catch {
        return invalidPlan(`planner step ${index + 1} args was not valid JSON`)
      }
    } else if (typeof step.args === 'object' && step.args !== null && !Array.isArray(step.args)) {
      // Accept the legacy local-model shape while existing conversations and
      // test fixtures migrate to the provider-compatible wire schema.
      args = step.args as Record<string, unknown>
    } else {
      return invalidPlan(`planner step ${index + 1} did not contain tool arguments`)
    }
    if (step.why !== undefined && typeof step.why !== 'string') {
      return invalidPlan(`planner step ${index + 1} had an invalid reason`)
    }
    if (step.bindings !== undefined && !Array.isArray(step.bindings)) {
      return invalidPlan(`planner step ${index + 1} had invalid bindings`)
    }
    const bindings: PlanBinding[] = []
    for (const binding of (step.bindings as unknown[] | undefined) ?? []) {
      if (typeof binding !== 'object' || binding === null || Array.isArray(binding)) {
        return invalidPlan(`planner step ${index + 1} had an invalid binding`)
      }
      const candidate = binding as Record<string, unknown>
      if (
        typeof candidate.arg !== 'string' ||
        !candidate.arg.trim() ||
        !Number.isInteger(candidate.fromStep) ||
        (candidate.fromStep as number) < 0 ||
        (candidate.fromStep as number) >= index ||
        typeof candidate.field !== 'string' ||
        !candidate.field.trim()
      ) {
        return invalidPlan(`planner step ${index + 1} had an invalid binding reference`)
      }
      bindings.push({
        arg: candidate.arg.trim(),
        fromStep: candidate.fromStep as number,
        field: candidate.field.trim()
      })
    }
    steps.push({ tool, args, why: typeof step.why === 'string' ? step.why : '', bindings })
  }
  return { valid: true, plan: { steps } }
}

/** Compatibility projection for pure callers that only need the safe plan. */
export function parsePlan(raw: string, knownToolNames: readonly string[]): Plan {
  return parsePlanResult(raw, knownToolNames).plan
}

/** Tools whose required `goal` arg IS the task and must never be blank - the
 *  rail drives that string. */
const GOAL_TOOLS = new Set(['web_use', 'computer_task'])

/** Unambiguous "this is a WEBSITE" signals. Used so a word in the request that
 *  happens to match a running app name ('music' -> the Music app) does NOT pull
 *  a web task onto the native app. Deliberately excludes app-ambiguous words
 *  (maps, mail, tv, spotify): only clear web markers count. */
const WEBSITE_HINTS =
  /(https?:\/\/|www\.|\.(com|org|net|io|co)\b|\byoutube\b|\byoutu\.be\b|\bgoogle\b|\bgmail\b|\bin the browser\b|\bon the web\b|\bwebsite\b|\bonline\b)/i

/** Does the request clearly name a website (a URL, youtube, google, ...)? */
export function namesWebsite(text: string): boolean {
  return WEBSITE_HINTS.test(text)
}

/** Deterministic backfill: a `web_use`/`computer_task` step whose `goal` the
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
    : parsed &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as { results?: unknown }).results)
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
