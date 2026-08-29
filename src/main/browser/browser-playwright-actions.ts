import type { BrowserDriver } from './browser-driver'
import type { PlaywrightMcpSession, PlaywrightToolResult } from './playwright-mcp-session'
import type { SemanticDecision } from './browser-playwright-policy'

/** Translate one policy decision into the public Playwright MCP tool contract. */
export async function executePlaywrightAction(
  session: PlaywrightMcpSession,
  decision: SemanticDecision,
  signal?: AbortSignal
): Promise<PlaywrightToolResult> {
  switch (decision.action) {
    case 'click':
      return session.call('browser_click', requiredRef(decision), signal)
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
  driver: BrowserDriver,
  decision: SemanticDecision,
  snapshot: string
): Promise<void> {
  const refs = decision.action === 'drag' ? [decision.start_ref, decision.end_ref] : [decision.ref]
  for (const ref of refs) {
    if (ref) await driver.projectSemanticTarget(ref, snapshot)
  }
}

/** Sensitive entry stays with the user even if the model fails to request HITL. */
export function isPrivateSemanticTarget(decision: SemanticDecision, snapshot: string): boolean {
  if (decision.action !== 'type' || !decision.ref) return false
  const line = snapshot.split('\n').find((candidate) => candidate.includes(`[ref=${decision.ref}]`))
  return /password|passcode|one[- ]?time|verification code|otp|captcha|card number|cvv|cvc/i.test(
    `${decision.element ?? ''} ${line ?? ''}`
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

function safeWebUrl(value: string | null): string {
  const parsed = new URL(value ?? '')
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Web Use navigation accepts only HTTP or HTTPS URLs.')
  }
  return parsed.toString()
}
