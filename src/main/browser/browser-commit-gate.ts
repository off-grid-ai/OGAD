/**
 * Send, pay and delete always ask the person first.
 *
 * The models decide what to click; this gate does not trust them to know which clicks cannot be
 * taken back. Before the agent clicks a button or link whose name commits something (sends a
 * message, pays, orders, books, deletes, transfers, posts), the task pauses and asks. The check
 * reads the element's own accessible name from the page snapshot, so a page cannot talk its way
 * past it, and it runs in the harness, so every model and every strategy goes through it.
 *
 * A key press asks too when it would do the same thing: Enter (or Space) on a commit button, and
 * Enter in a field whose form submits through a commit button (implicit form submission).
 *
 * Sandbox test profiles (sandbox-profiles.ts) skip the question: nothing there is real.
 */

import type { PlaywrightToolResult } from './playwright-mcp-session'

/** Whole names that commit something, with or without the object they act on. */
const COMMIT_NAME =
  /^(?:send(?: now| message| email| reply| it)?|reply(?: all)?|forward|post(?: now)?|publish|tweet|share now|pay(?: now| bill| securely| \S+)?|buy(?: now| it now)?|purchase|order now|place(?: your)? order|complete (?:purchase|order|payment|booking|checkout)|confirm(?: and pay| payment| purchase| order| booking| transfer| delete| deletion| cancellation)?|submit(?: payment| order| application| claim| return| request)?|book(?: now| flight| hotel| it| appointment)?|reserve(?: now)?|check ?out|proceed to (?:checkout|payment)|delete(?: forever| permanently| account| all| message| conversation)?|remove(?: account)?|empty (?:trash|bin)|transfer(?: money| funds| now)?|send money|withdraw|donate|subscribe|unsubscribe|cancel (?:subscription|order|booking|membership|plan|reservation|account)|request (?:refund|return)|start return|sign and submit|accept (?:offer|invitation)|decline invitation)$/i

/**
 * A commit verb followed by whatever it acts on: "Delete file", "Send a message to our support
 * team", "Pay $20", "Place an order". The verb must be its own word, so "Payment methods",
 * "Sent mail", "Postcode" and "Pay-as-you-go plans" stay ordinary.
 */
const COMMIT_VERB_OBJECT =
  /^(?:(?:send|pay|delete|transfer|purchase|buy|publish|donate|withdraw|reply|forward|unsubscribe|post) .+|place (?:(?:a|an|the|your|my|this) )?order(?: .+)?)$/i

/** Snapshot line roles a person clicks to commit. */
const CLICKABLE = /^(?:button|link|menuitem|menuitemradio|option)$/

/**
 * The longest name read as a command. A button's name is what it does, however long; a link or
 * menu item with a long name is usually a headline or an article ("Send money abroad: a guide").
 */
const MAX_BUTTON_NAME = 100
const MAX_LINK_NAME = 40

/** The plain name of a snapshot element: `- button "Send" [ref=e12]` → Send. */
export function snapshotElement(line: string): { role: string; name: string } | null {
  const match = /^\s*- ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?/.exec(line)
  if (!match) return null
  return { role: match[1]!, name: (match[2] ?? '').replace(/\\"/g, '"').trim() }
}

/**
 * The commit the click would make, worded for the question ("Send"), or null for an ordinary
 * click. Matches the whole name, so "Sent mail" or "Payment methods" are not gated.
 */
export function commitClick(line: string | undefined): string | null {
  const element = line ? snapshotElement(line) : null
  if (!element || !CLICKABLE.test(element.role)) return null
  const name = element.name.replace(/\s+/g, ' ').replace(/[.…!]+$/, '')
  const longest = element.role === 'button' ? MAX_BUTTON_NAME : MAX_LINK_NAME
  if (!name || name.length > longest) return null
  return COMMIT_NAME.test(name) || COMMIT_VERB_OBJECT.test(name) ? name : null
}

/**
 * The snapshot line for a ref, as commitClick reads it. Playwright quotes a YAML line whose text
 * needs it (`- 'button "Pay: now"' [ref=e2]`); the quotes come off.
 */
export function refSnapshotLine(snapshot: string, ref: string): string | undefined {
  return snapshot
    .split('\n')
    .find((candidate) => candidate.includes(`[ref=${ref}]`))
    ?.replace(/^(\s*- )'(.*)'(:.*)?$/, '$1$2$3')
}

/** The commit a click on this ref would make, or null. */
export function commitAtRef(snapshot: string, ref: string | null | undefined): string | null {
  return ref ? commitClick(refSnapshotLine(snapshot, ref)) : null
}

/** A key that submits a message composer (Gmail, Slack, Outlook: Ctrl/Cmd+Enter). */
export function commitKey(key: string): boolean {
  return /^(?:Control|Meta)\+Enter$/i.test(key)
}

/** Enter, with or without modifiers: activates the focused control or submits its form. */
const ENTER_KEY = /^(?:(?:Control|Meta|Shift|Alt)\+)*Enter$/i
/** Space activates a focused button or link; it never submits a form from a text field. */
const SPACE_KEY = /^(?:Space| )$/

/**
 * Runs in the page (browser_evaluate): the focused control and, when Enter in that field would
 * submit its form, the form's default button (its first submit button, HTML implicit
 * submission). Each comes back as a snapshot line, `- button "Place order"`, for commitClick.
 */
export const FOCUSED_SUBMIT_SCRIPT = `() => {
  const name = (el) => {
    const labelled = (el.getAttribute('aria-labelledby') || '')
      .split(/\\s+/)
      .map((id) => (id && document.getElementById(id)?.textContent) || '')
      .join(' ')
      .trim()
    const own = el.tagName === 'INPUT'
      ? el.value || (el.type === 'image' ? el.alt : '') || (el.type === 'submit' ? 'Submit' : '')
      : el.innerText || el.textContent || ''
    return (el.getAttribute('aria-label') || labelled || own || el.title || '').replace(/\\s+/g, ' ').trim()
  }
  const role = (el) => {
    const explicit = (el.getAttribute('role') || '').trim().split(/\\s+/)[0]
    if (explicit) return explicit
    if (el.tagName === 'A' && el.hasAttribute('href')) return 'link'
    if (el.tagName === 'BUTTON') return 'button'
    if (el.tagName === 'INPUT' && /^(submit|button|image|reset)$/.test(el.type)) return 'button'
    return 'generic'
  }
  const line = (el) => '- ' + role(el) + ' ' + JSON.stringify(name(el))
  let focused = document.activeElement
  while (focused && focused.shadowRoot && focused.shadowRoot.activeElement) {
    focused = focused.shadowRoot.activeElement
  }
  if (!focused || focused === document.body) return JSON.stringify({ focused: null, submit: null })
  const submits = focused.tagName === 'INPUT' && focused.form && !/^(submit|button|image|reset|checkbox|radio|file)$/.test(focused.type)
  const button = submits
    ? Array.from(focused.form.elements).find((el) =>
        (el.tagName === 'BUTTON' && el.type === 'submit') ||
        (el.tagName === 'INPUT' && /^(submit|image)$/.test(el.type)))
    : null
  return JSON.stringify({ focused: line(focused), submit: button ? line(button) : null })
}`

interface FocusedSubmit {
  focused: string | null
  submit: string | null
}

/** What FOCUSED_SUBMIT_SCRIPT returned. Playwright MCP prints it JSON-encoded under "### Result". */
function focusedSubmit(result: PlaywrightToolResult | null): FocusedSubmit | null {
  if (!result || result.isError) return null
  const section =
    /### Result\s*\n([\s\S]*?)(?:\n###|$)/.exec(result.text)?.[1]?.trim() ?? result.text.trim()
  try {
    let value: unknown = JSON.parse(section)
    if (typeof value === 'string') value = JSON.parse(value)
    const read = value as Partial<FocusedSubmit> | null
    if (!read || typeof read !== 'object') return null
    return {
      focused: typeof read.focused === 'string' ? read.focused : null,
      submit: typeof read.submit === 'string' ? read.submit : null
    }
  } catch {
    return null
  }
}

/** The page tool the key check reads focus through. */
export type CommitKeySession = {
  call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<PlaywrightToolResult>
}

/**
 * The commit a key press would make, worded for the question, or null. Ctrl/Cmd+Enter sends a
 * composer. Enter or Space on a focused commit button commits; Enter in a field whose form's
 * default button commits submits it. Enter in an ordinary search field passes.
 *
 * Focus is read in the page. A session that cannot run page scripts (a Firefox tab) falls back
 * to the snapshot's focused element (`[active]`), which covers a focused commit button.
 */
export async function commitKeyPress(
  session: CommitKeySession,
  key: string,
  snapshot: string,
  signal?: AbortSignal
): Promise<string | null> {
  if (commitKey(key)) return 'Send'
  const enter = ENTER_KEY.test(key)
  if (!enter && !SPACE_KEY.test(key)) return null
  const read = focusedSubmit(
    await session
      .call('browser_evaluate', { function: FOCUSED_SUBMIT_SCRIPT }, signal)
      .catch(() => null)
  )
  const focused =
    read?.focused ??
    snapshot
      .split('\n')
      .find((line) => /\[active\]/.test(line))
      ?.replace(/^(\s*- )'(.*)'(:.*)?$/, '$1$2$3')
  return (
    commitClick(focused ?? undefined) ?? (enter ? commitClick(read?.submit ?? undefined) : null)
  )
}
