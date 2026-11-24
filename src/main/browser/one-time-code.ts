import { getDomain } from 'tldts'

/**
 * One-time codes sent by email, for the web agent's sign-in (browser-emailed-code.ts).
 *
 * Pure rules, no I/O: which page field takes a one-time code, which code an email holds, and
 * which emails may answer a page. The guardrails live here so they are tested in one place:
 *  - only mail from the page's own site (same registrable domain) answers it;
 *  - only mail received after the code was asked for;
 *  - two different codes are a question for the person, never a guess.
 */

/** One input of the page, as the field scan reads it: attributes and label text, never a value. */
export interface CodeFieldCandidate {
  /** Position among the page's visible text inputs (the fill uses it). */
  index: number
  type: string
  autocomplete: string
  /** name, id, aria-label, placeholder and label text, joined. */
  hint: string
  maxLength: number
  hasValue: boolean
}

export interface CodeField {
  /** One input, or the row of single-character boxes. */
  indexes: number[]
  filled: boolean
}

/** Words that name a one-time code field on their own. */
const STRONG_FIELD =
  /one[-_ ]?time|\botp\b|\btotp\b|\b2fa\b|\bmfa\b|verification|verify|passcode|security[-_ ]?code|auth(?:entication)?[-_ ]?code|(?:sign|log)[-_ ]?in[-_ ]?code|confirmation[-_ ]?code|access[-_ ]?code/i
/** "Code" alone, which also names promo, postal and card codes. */
const WEAK_FIELD = /\bcode\b/i
const NOT_A_SIGN_IN_CODE =
  /promo|coupon|discount|gift|voucher|referral|zip|postal|post[-_ ]?code|country|area|dial|sort[-_ ]?code|swift|iban|\bbic\b|tax|cvv|cvc|csc|card|booking|reservation|confirmation number|invite/i
/** Page text that says a code was just sent. */
const CODE_SENT =
  /\b(?:sent|emailed|email(?:ed)? you|check your (?:email|inbox))\b[^.]{0,60}\bcode\b|\bcode\b[^.]{0,60}\b(?:sent|emailed|to your email|in your inbox)\b/i

function isCodeInput(field: CodeFieldCandidate, pageSaysSent: boolean): boolean {
  if (field.type === 'password' && !/one-time-code/i.test(field.autocomplete)) return false
  if (/^cc-/i.test(field.autocomplete)) return false
  if (/one-time-code/i.test(field.autocomplete)) return true
  if (NOT_A_SIGN_IN_CODE.test(field.hint)) return false
  if (STRONG_FIELD.test(field.hint)) return true
  return pageSaysSent && WEAK_FIELD.test(field.hint)
}

/**
 * The page's one-time code field, if it has one: a single input named for a code, or a row of 4-8
 * single-character boxes on a page that says a code was sent.
 */
export function findCodeField(
  candidates: readonly CodeFieldCandidate[],
  pageText: string
): CodeField | null {
  const pageSaysSent = CODE_SENT.test(pageText)
  const single = candidates.find((field) => field.maxLength !== 1 && isCodeInput(field, pageSaysSent))
  if (single) return { indexes: [single.index], filled: single.hasValue }
  // Split boxes: consecutive maxlength=1 inputs. Their hints are often empty, so the page text
  // (or a code word on any box) decides.
  const boxes = candidates.filter((field) => field.maxLength === 1 && field.type !== 'password')
  let run: CodeFieldCandidate[] = []
  const runs: CodeFieldCandidate[][] = []
  for (const box of boxes) {
    if (run.length && box.index !== run[run.length - 1]!.index + 1) {
      runs.push(run)
      run = []
    }
    run.push(box)
  }
  if (run.length) runs.push(run)
  const row = runs.find(
    (r) =>
      r.length >= 4 &&
      r.length <= 8 &&
      (pageSaysSent || r.some((box) => isCodeInput({ ...box, maxLength: 0 }, true)))
  )
  return row
    ? { indexes: row.map((box) => box.index), filled: row.every((box) => box.hasValue) }
    : null
}

/** A code: 4-8 digits, or 4-8 letters and digits with at least one digit; "123 456" is one code. */
const CODE_TOKEN = String.raw`(\d{3}[ -]\d{3}|\d{4,8}|(?=[A-Z0-9-]*\d)[A-Z0-9]{2,4}-?[A-Z0-9]{2,4})`
const CODE_WORD = String.raw`(?:one[- ]time (?:pass(?:word|code)|code|pin)|verification code|security code|confirmation code|sign[- ]in code|log[- ]?in code|access code|auth(?:entication)? code|passcode|\botp\b|\bpin\b|\bcode\b)`
const AFTER_WORD = new RegExp(
  String.raw`${CODE_WORD}(?:\s+(?:is|was|below)|\s+for [^:\n]{1,40}?(?:\s+is|:))?\s*[:\-–—]?\s*${CODE_TOKEN}(?![A-Za-z0-9])`,
  'gi'
)
const BEFORE_WORD = new RegExp(
  String.raw`(?<![A-Za-z0-9])${CODE_TOKEN}\s+is\s+(?:your|the)\s+(?:[\w-]+\s+){0,3}?${CODE_WORD}`,
  'gi'
)
/** A line holding only the code, as most code emails print it. */
const LINE_ONLY = /^[ \t>*_]*(\d{3}[ -]\d{3}|\d{4,8}|(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{4,8})[ \t*_.]*$/gm
/** An email that is about a code at all. */
const CODE_MAIL = new RegExp(CODE_WORD, 'i')

function normalizeCode(raw: string): string {
  return raw.replace(/[ -]/g, '').toUpperCase()
}

function isPlausible(code: string, context: 'word' | 'line'): boolean {
  if (code.length < 4 || code.length > 8) return false
  // A bare 4-digit year on its own line is a footer, not a code.
  if (context === 'line' && /^(19|20)\d\d$/.test(code)) return false
  return true
}

/**
 * The one-time codes an email holds, deduplicated. Usually one (subject and body repeat it);
 * none when the email is not a code email; more than one is ambiguous.
 */
export function extractOneTimeCodes(subject: string, text: string): string[] {
  const body = `${subject}\n${text}`.replace(/\r/g, '').replace(/ /g, ' ')
  if (!CODE_MAIL.test(body)) return []
  const found = new Set<string>()
  for (const pattern of [AFTER_WORD, BEFORE_WORD]) {
    for (const match of body.matchAll(pattern)) {
      const raw = match[1]
      if (!raw) continue
      // Alphanumeric codes are printed in capitals; "code is below" must not read "below".
      if (/[a-z]/.test(raw)) continue
      const code = normalizeCode(raw)
      if (isPlausible(code, 'word')) found.add(code)
    }
  }
  if (found.size === 0) {
    for (const match of body.matchAll(LINE_ONLY)) {
      const code = normalizeCode(match[1]!)
      if (isPlausible(code, 'line')) found.add(code)
    }
  }
  return [...found]
}

/** The address in a From header: `Harbour Bank <no-reply@offgrid-bank.test>` → its domain. */
export function senderDomain(from: string): string | null {
  const address = /<([^<>\s]+@[^<>\s]+)>/.exec(from)?.[1] ?? /([^\s<>"]+@[^\s<>"]+)/.exec(from)?.[1]
  const domain = address?.split('@').pop()?.toLowerCase().replace(/\.$/, '')
  return domain && /^[a-z0-9.-]+$/.test(domain) ? domain : null
}

/** The site a page or sender belongs to: its registrable domain (mail.bank.com → bank.com). */
export function siteOf(host: string): string | null {
  const clean = host.toLowerCase().replace(/\.$/, '')
  if (!clean || /^[\d.]+$/.test(clean) || clean.includes(':')) return null
  return getDomain(clean, { allowPrivateDomains: true }) ?? null
}

/** Only mail from the site that asked: same registrable domain as the page. */
export function senderMatchesSite(from: string, pageUrl: string): boolean {
  let host: string
  try {
    host = new URL(pageUrl).hostname
  } catch {
    return false
  }
  const domain = senderDomain(from)
  const pageSite = siteOf(host)
  return Boolean(domain && pageSite && siteOf(domain) === pageSite)
}

export interface CodeMail {
  from: string
  subject: string
  text: string
  /** When the mailbox received it (ms). */
  receivedAt: number
}

export type CodeDecision =
  | { kind: 'code'; code: string }
  | { kind: 'none' }
  | { kind: 'conflict'; reason: string }

/** Two codes this close together cannot be told apart by which came last. */
const SAME_MOMENT_MS = 15_000

/**
 * Which code answers the page. Fresh mail from the page's site only; the newest code email wins
 * (sites cancel the older code when they send a new one), unless another fresh email with a
 * different code arrived at about the same moment, or one email holds two codes.
 */
export function pickEmailedCode(
  mail: readonly CodeMail[],
  request: { pageUrl: string; requestedAt: number }
): CodeDecision {
  const coded = mail
    .filter((m) => m.receivedAt >= request.requestedAt && senderMatchesSite(m.from, request.pageUrl))
    .map((m) => ({ mail: m, codes: extractOneTimeCodes(m.subject, m.text) }))
    .filter((m) => m.codes.length > 0)
    .sort((a, b) => b.mail.receivedAt - a.mail.receivedAt)
  const newest = coded[0]
  if (!newest) return { kind: 'none' }
  if (newest.codes.length > 1) return { kind: 'conflict', reason: 'the email holds more than one code' }
  const code = newest.codes[0]!
  const rival = coded.find(
    (m) =>
      m !== newest &&
      newest.mail.receivedAt - m.mail.receivedAt < SAME_MOMENT_MS &&
      m.codes.some((other) => other !== code)
  )
  return rival
    ? { kind: 'conflict', reason: 'two emails with different codes arrived together' }
    : { kind: 'code', code }
}
