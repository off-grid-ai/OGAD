import type { BrowserDriver } from './browser-driver'
import type { PlaywrightToolResult, SemanticPageSession } from './playwright-mcp-session'
import type { SemanticDecision } from './browser-playwright-policy'

/** Translate one policy decision into the public Playwright MCP tool contract. */
export async function executePlaywrightAction(
  session: SemanticPageSession,
  decision: SemanticDecision,
  signal?: AbortSignal
): Promise<PlaywrightToolResult> {
  switch (decision.action) {
    case 'click':
      return clickWithFallback(session, requiredRef(decision), signal)
    case 'type':
      return session.call(
        'browser_type',
        {
          ...requiredRef(decision),
          text: requiredValue(decision.text, 'type text'),
          submit: false,
          slowly: false
        },
        signal
      )
    case 'press_key':
      return session.call(
        'browser_press_key',
        { key: requiredValue(decision.key, 'keyboard key') },
        signal
      )
    case 'select_option':
      return session.call(
        'browser_select_option',
        { ...requiredRef(decision), values: requiredValues(decision.values) },
        signal
      )
    case 'hover':
      return session.call('browser_hover', requiredRef(decision), signal)
    case 'drag':
      return session.call(
        'browser_drag',
        {
          startElement: requiredValue(decision.start_element, 'drag start element'),
          startTarget: requiredValue(decision.start_ref, 'drag start reference'),
          endElement: requiredValue(decision.end_element, 'drag end element'),
          endTarget: requiredValue(decision.end_ref, 'drag end reference')
        },
        signal
      )
    case 'navigate':
      return session.call('browser_navigate', { url: safeWebUrl(decision.url) }, signal)
    default:
      throw new Error(`Web Use cannot execute terminal action ${decision.action}.`)
  }
}

/** Keep the existing Off Grid pointer visible while Playwright performs the action. */
export async function projectPlaywrightPointer(
  driver: BrowserDriver | null,
  decision: SemanticDecision,
  snapshot: string
): Promise<void> {
  if (!driver) return
  const refs = decision.action === 'drag' ? [decision.start_ref, decision.end_ref] : [decision.ref]
  for (const ref of refs) {
    if (ref) await driver.projectSemanticTarget(ref, snapshot)
  }
}

/** Sensitive entry stays with the user even if the model fails to request HITL. */
/** A human check: the user does it. Found live: the model set out to tick "I am human". */
const HUMAN_CHECK =
  /captcha|i am human|i'?m not a robot|not a robot|turnstile|verify (?:that )?you are human/i

export function isPrivateSemanticTarget(decision: SemanticDecision, snapshot: string): boolean {
  if (!decision.ref) return false
  const line = snapshot.split('\n').find((candidate) => candidate.includes(`[ref=${decision.ref}]`))
  const target = `${decision.element ?? ''} ${line ?? ''}`
  if (HUMAN_CHECK.test(target)) return true
  return (
    decision.action === 'type' &&
    /password|passcode|one[- ]?time|verification code|otp|card number|cvv|cvc/i.test(target)
  )
}

function requiredRef(decision: SemanticDecision): { element: string; target: string } {
  const target = requiredValue(decision.ref, 'Playwright reference')
  return { element: requiredValue(decision.element, 'element label'), target }
}

function requiredValue(value: string | null, label: string): string {
  if (value === null || !value.trim()) throw new Error(`${label} is required.`)
  return value
}

function requiredValues(values: string[] | null): string[] {
  if (!values?.length) throw new Error('At least one select option is required.')
  return values
}

export function safeWebUrl(value: string | null): string {
  const parsed = new URL(value ?? '')
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Web Use navigation accepts only HTTP or HTTPS URLs.')
  }
  return parsed.toString()
}

/**
 * A navigate to the page that is already open. Found live: a plan began "Navigate to the sign-up
 * page" while the user was on it, and the reload cleared what was filled. Same origin and path is
 * the same page, so a URL without the page's own query token still counts.
 */
export function isNavigateToCurrentPage(decision: SemanticDecision, currentUrl: string): boolean {
  if (decision.action !== 'navigate' || !decision.url) return false
  try {
    const to = new URL(decision.url)
    const at = new URL(currentUrl)
    return (
      to.origin === at.origin && to.pathname.replace(/\/$/, '') === at.pathname.replace(/\/$/, '')
    )
  } catch {
    return false
  }
}

/** Playwright gave up waiting for the element to be visible, enabled and stable. */
export function isActionabilityTimeout(result: PlaywrightToolResult): boolean {
  return (
    result.isError &&
    /visible, enabled and stable|waiting for element to be/i.test(result.text) &&
    /timeout/i.test(result.text)
  )
}

/**
 * A trusted click, and an in-page click when Playwright cannot prove the element stable: a
 * window that is covered, minimized or on a sleeping display draws no frames, and the trusted
 * click then waits out its timeout (found live on a plain radio button). Nanobrowser falls back
 * the same way. The page's own handlers still run.
 */
export async function clickWithFallback(
  session: SemanticPageSession,
  ref: { element: string; target: string },
  signal?: AbortSignal
): Promise<PlaywrightToolResult> {
  const trusted = await session.call('browser_click', ref, signal)
  if (!isActionabilityTimeout(trusted)) return trusted
  const inPage = await session.call(
    'browser_evaluate',
    {
      ...ref,
      function:
        '(element) => { element.scrollIntoView({ block: "center" }); element.click(); return "clicked" }'
    },
    signal
  )
  return inPage.isError ? trusted : { text: `Clicked ${ref.element} in the page.`, isError: false }
}
