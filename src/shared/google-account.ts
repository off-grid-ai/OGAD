// The account-identity rule for Google connectors: what an account IS, how it is named, how its
// data is keyed, and which of its calendars are read.
//
// MISPLACED ON PURPOSE. By the hexagonal rule in `rules.md` this belongs in a shared `@offgrid/*`
// package, because Mobile will need the same rules verbatim. It is parked here for one round with
// `shared` out of scope. So it is written to be LIFTED, not rewritten: pure functions and types
// only - no Electron, no database, no IPC, no fetch, no filesystem. Moving it is a file relocation
// plus an import rewrite in `src/main/mcp.ts`, `src/main/mcp-oauth.ts`, `src/main/google-*`,
// `pro/main/google-rest.ts`, `pro/main/ingest.ts`, `pro/main/crm/calendar.ts` and
// `src/renderer/src/components/ConnectorsScreen.tsx`. Nothing else imports it.

/**
 * A connected Google account.
 *
 * Identity is provider + subject. `subject` is the OpenID `sub` claim: Google's immutable
 * per-account id, stable across a rename and never reissued. An email address is NEITHER stable
 * (people rename mailboxes) NOR unique over time (a freed Workspace address is handed to the next
 * hire), so it is display and search material only, never identity. `email` is therefore optional
 * and may change on any refresh; `subject` may not.
 */
export interface GoogleAccount {
  provider: 'google'
  subject: string
  email?: string
  name?: string
}

/** The identity half alone, for callers that key data and never display it. */
export type GoogleAccountRef = Pick<GoogleAccount, 'provider' | 'subject'>

/**
 * The durable string form of an account identity - what goes in a database column or a dedup key.
 *
 * Provider-qualified so a future Microsoft account with a colliding subject cannot occupy the same
 * key space, and so a stored key says what it is when read back years later.
 */
export function googleAccountKey(account: GoogleAccountRef): string {
  return `google:${account.subject}`
}

/** Parse a stored account key back to an identity, or null when it names no Google account. */
export function parseGoogleAccountKey(value: string | null | undefined): GoogleAccountRef | null {
  if (!value) return null
  const subject = value.startsWith('google:') ? value.slice('google:'.length).trim() : ''
  return subject ? { provider: 'google', subject } : null
}

/** True when two references name the same account. Subject only - a changed email is not a move. */
export function isSameGoogleAccount(
  a: GoogleAccountRef | null | undefined,
  b: GoogleAccountRef | null | undefined
): boolean {
  return !!a && !!b && a.provider === b.provider && a.subject === b.subject
}

/**
 * Read an account identity out of a Google `userinfo` / OpenID payload.
 *
 * Returns null without a `sub`. A payload carrying only an email is NOT an identity: accepting it
 * would let a renamed mailbox read as a new account and a reused address as an old one. Callers
 * that get null must report "could not identify this account", never invent one from the email.
 */
export function googleAccountFromUserInfo(payload: {
  sub?: unknown
  email?: unknown
  name?: unknown
}): GoogleAccount | null {
  const subject = typeof payload.sub === 'string' ? payload.sub.trim() : ''
  if (!subject) return null
  const email = typeof payload.email === 'string' ? payload.email.trim() : ''
  const name = typeof payload.name === 'string' ? payload.name.trim() : ''
  return {
    provider: 'google',
    subject,
    ...(email ? { email } : {}),
    ...(name ? { name } : {})
  }
}

/**
 * The connector row name for one account of one service, e.g. "Gmail (ada@example.com)".
 *
 * Two accounts of the same service must not share a display name: the name reaches observation
 * rows as their surface, and identical names make two mailboxes indistinguishable in Day, Reflect
 * and search. An account whose email is not known yet is disambiguated by its subject instead, so
 * the name is unique even before the first profile read succeeds.
 */
export function googleConnectorName(service: string, account: GoogleAccount | null): string {
  if (!account) return service
  const label = account.email || `id ${account.subject.slice(0, 8)}`
  return `${service} (${label})`
}

/**
 * Whether a catalog entry may be connected more than once.
 *
 * Keying the installed set by entry NAME hid a provider's card as soon as one account was
 * connected, which is why a second Google account was impossible. A provider that authenticates a
 * per-user identity can hold several; a workspace-wide token or a local stdio server cannot, and
 * repeating those would just create a duplicate of the same data.
 */
export function providerSupportsMultipleAccounts(entry: {
  auth: string
  oauthClient?: string
}): boolean {
  return entry.auth === 'oauth' && entry.oauthClient === 'byo'
}

/**
 * The Gmail deep link for one message IN THE RIGHT MAILBOX.
 *
 * `/mail/u/0/` means "whichever account the browser signed in first", so it opened the wrong
 * mailbox for every account but one. `authuser` pins it to this account's address; without a known
 * address there is nothing to pin to and the unqualified link is the honest fallback.
 */
export function gmailMessageUrl(messageId: string, account: GoogleAccount | null): string {
  const base = 'https://mail.google.com/mail'
  if (!account?.email) return `${base}/#all/${messageId}`
  return `${base}/u/?authuser=${encodeURIComponent(account.email)}#all/${messageId}`
}

/** A calendar the user can choose to read, as returned by `calendarList`. */
export interface GoogleCalendarChoice {
  /** The Calendar API id - an email-shaped opaque string, unique within the account. */
  id: string
  summary: string
  primary: boolean
  /** The account's own default time zone for this calendar, when it declares one. */
  timeZone?: string
}

/**
 * Which calendars to read for one account.
 *
 * An account with NO recorded choice reads its primary calendar - the same events the
 * single-account build read, so an upgrade changes nothing until the user chooses. An explicit
 * empty choice is a real choice ("read none of them") and must not silently fall back to primary,
 * or unticking every calendar would look broken.
 */
export function calendarsToRead(input: {
  selected: readonly string[] | null | undefined
  available: readonly GoogleCalendarChoice[]
}): string[] {
  if (!input.selected) {
    const primary = input.available.find((calendar) => calendar.primary)
    return [primary?.id ?? 'primary']
  }
  if (!input.available.length) return [...new Set(input.selected)]
  const known = new Set(input.available.map((calendar) => calendar.id))
  return [...new Set(input.selected)].filter((id) => known.has(id))
}

/**
 * The identity of one imported event or message: which account it came from, and its id THERE.
 *
 * Both halves are required. A remote id alone collapses one meeting across two accounts into a
 * single row - each account overwriting the other's link and source on every sync - and an account
 * alone cannot tell two of its own events apart.
 */
export function remoteItemDedupKey(input: { account: GoogleAccountRef; remoteId: string }): string {
  return `${googleAccountKey(input.account)}|${input.remoteId.trim()}`
}

/**
 * Whether a stored dedup key was written by the account-scoped rule.
 *
 * The single-account build keyed events on `title + day`, which merged the same meeting seen by
 * two accounts. Those rows cannot be split apart after the fact - the merge already discarded
 * which account contributed what - so a migration must recognise them, leave the merged row to be
 * replaced by the next authenticated sync, and never treat it as already correct.
 */
export function isAccountScopedDedupKey(value: string | null | undefined): boolean {
  return !!value && parseGoogleAccountKey(value.split('|')[0]) !== null
}
