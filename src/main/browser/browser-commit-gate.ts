/**
 * Send, pay and delete always ask the person first.
 *
 * The models decide what to click; this gate does not trust them to know which clicks cannot be
 * taken back. Before the agent clicks a button or link whose name commits something (sends a
 * message, pays, orders, books, deletes, transfers, posts), the task pauses and asks. The check
 * reads the element's own accessible name from the page snapshot, so a page cannot talk its way
 * past it, and it runs in the harness, so every model and every strategy goes through it.
 *
 * Sandbox test profiles (sandbox-profiles.ts) skip the question: nothing there is real.
 */

const COMMIT_NAME =
  /^(?:send(?: now| message| email| reply| it)?|reply(?: all)?|forward|post(?: now)?|publish|tweet|share now|pay(?: now| bill| securely| \S+)?|buy(?: now| it now)?|purchase|order now|place(?: your)? order|complete (?:purchase|order|payment|booking|checkout)|confirm(?: and pay| payment| purchase| order| booking| transfer| delete| deletion| cancellation)?|submit(?: payment| order| application| claim| return| request)?|book(?: now| flight| hotel| it| appointment)?|reserve(?: now)?|check ?out|proceed to (?:checkout|payment)|delete(?: forever| permanently| account| all| message| conversation)?|remove(?: account)?|empty (?:trash|bin)|transfer(?: money| funds| now)?|send money|withdraw|donate|subscribe|unsubscribe|cancel (?:subscription|order|booking|membership|plan|reservation|account)|request (?:refund|return)|start return|sign and submit|accept (?:offer|invitation)|decline invitation)$/i

/** Snapshot line roles a person clicks to commit. */
const CLICKABLE = /^(?:button|link|menuitem|menuitemradio|option)$/

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
  if (!name || name.length > 40) return null
  return COMMIT_NAME.test(name) ? name : null
}

/** A key that submits a message composer (Gmail, Slack, Outlook: Ctrl/Cmd+Enter). */
export function commitKey(key: string): boolean {
  return /^(?:Control|Meta)\+Enter$/i.test(key)
}
