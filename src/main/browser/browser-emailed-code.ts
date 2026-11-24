import type { WebContents } from 'electron'
import { callHookAsync, hasHook, HOOKS } from '../bootstrap/hookRegistry'
import { listConnectors } from '../mcp'
import { IMAP_URL_PREFIX, readImapCodeMail } from '../mail/imap-mailbox'
import { FILL_WORLD } from './browser-vault-fill'
import {
  findCodeField,
  pickEmailedCode,
  siteOf,
  type CodeField,
  type CodeFieldCandidate,
  type CodeMail
} from './one-time-code'

/**
 * Sign-in codes sent by email, filled by the harness the way the Vault fills a password: the code
 * goes mailbox → main → the page's field in an isolated world. It never reaches a model, the
 * browser chrome or a log, and browser-secret-scrub.ts masks it in snapshots and tool results.
 *
 * Guardrails: only the person's own connected mailboxes; only mail from the page's own site;
 * only mail received after the code was asked for. No code, or two codes, and the agent asks the
 * person as before.
 */

/** Visible text-like inputs, in page order: attributes and label text only, never a value. */
const VISIBLE_INPUTS = `const visible = (el) => {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.disabled && !el.readOnly
  }
  const inputs = Array.from(document.querySelectorAll('input')).filter((el) =>
    ['text', 'tel', 'number', 'password', 'email', ''].includes(el.type) && visible(el))`

const SCAN_SCRIPT = `(() => {
  ${VISIBLE_INPUTS}
  const labelText = (el) => [
    ...Array.from(el.labels || []).map((l) => l.innerText),
    ...(el.getAttribute('aria-labelledby') || '').split(/\\s+/).map((id) => document.getElementById(id)?.innerText || '')
  ].join(' ')
  const fields = inputs.map((el, index) => ({
    index,
    type: el.type,
    autocomplete: el.autocomplete || el.getAttribute('autocomplete') || '',
    hint: [el.name, el.id, el.getAttribute('aria-label'), el.placeholder, el.title, labelText(el)].filter(Boolean).join(' ').slice(0, 300),
    maxLength: el.maxLength,
    hasValue: el.value.length > 0
  }))
  return { fields, text: (document.body?.innerText || '').slice(0, 4000) }
})()`

function fillScript(indexes: number[], code: string): string {
  return `(() => {
  ${VISIBLE_INPUTS}
  const set = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set
    el.focus()
    if (setter) setter.call(el, value); else el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const indexes = ${JSON.stringify(indexes)}
  const code = ${JSON.stringify(code)}
  const targets = indexes.map((i) => inputs[i])
  if (targets.some((el) => !el)) return 'none'
  if (targets.length === 1) set(targets[0], code)
  else targets.forEach((el, i) => set(el, code[i] || ''))
  return 'filled'
})()`
}

/** The page's one-time code field, or null. Reads attributes and page text, never values. */
export async function readCodeField(contents: WebContents): Promise<CodeField | null> {
  const scan = (await contents
    .executeJavaScriptInIsolatedWorld(FILL_WORLD, [{ code: SCAN_SCRIPT }])
    .catch(() => null)) as { fields?: CodeFieldCandidate[]; text?: string } | null
  if (!scan || !Array.isArray(scan.fields)) return null
  return findCodeField(scan.fields, typeof scan.text === 'string' ? scan.text : '')
}

export interface CodeMailQuery {
  /** The page's registrable domain: only mail from it is read. */
  domain: string
  sinceMs: number
}

function imapConnectorIds(): number[] {
  return listConnectors()
    .filter((c) => c.enabled && c.url?.toLowerCase().startsWith(IMAP_URL_PREFIX))
    .map((c) => c.id)
}

/** Whether any connected mailbox can be asked for a code. */
export function hasCodeMailbox(): boolean {
  return imapConnectorIds().length > 0 || hasHook(HOOKS.browserCodeMail)
}

/**
 * Fresh mail from one site across the person's connected mailboxes: IMAP accounts here, Gmail and
 * Outlook through Pro. Each read is live from the provider, so it is the mailbox's sync.
 */
export async function readCodeMail(query: CodeMailQuery): Promise<CodeMail[]> {
  const reads: Promise<CodeMail[]>[] = imapConnectorIds().map((id) =>
    readImapCodeMail(id, query).catch((error: unknown) => {
      // The error, never a message: no subject, sender or body reaches the log.
      console.warn('[web-use][code] mailbox read failed', {
        connector: id,
        error: error instanceof Error ? error.message.slice(0, 160) : 'unknown'
      })
      return []
    })
  )
  if (hasHook(HOOKS.browserCodeMail)) {
    reads.push(
      callHookAsync<CodeMail[]>(HOOKS.browserCodeMail, query)
        .then((mail) => mail ?? [])
        .catch(() => [])
    )
  }
  return (await Promise.all(reads)).flat()
}

export type EmailedCodeOutcome =
  | { kind: 'filled'; site: string }
  | { kind: 'no_mailbox' }
  | { kind: 'no_code'; site: string }
  | { kind: 'conflict'; site: string; reason: string }
  | { kind: 'left_page' }

/** How long a person would wait for a code email. OFFGRID_EMAILED_CODE_WAIT_MS overrides. */
function waitBudgetMs(): number {
  const fromEnv = Number(process.env.OFFGRID_EMAILED_CODE_WAIT_MS)
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : 150_000
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true }
    )
  })
}

/**
 * Wait for the site's code email and fill it into the page's code field. `onSecret` gets the code
 * first, so it is masked before the field is read again.
 */
export async function fillEmailedCode(
  contents: WebContents,
  field: CodeField,
  options: {
    requestedAt: number
    onSecret: (secret: string) => void
    onWaiting?: (site: string) => void
    signal?: AbortSignal
    readMail?: (query: CodeMailQuery) => Promise<CodeMail[]>
    waitMs?: number
    pollMs?: number
  }
): Promise<EmailedCodeOutcome> {
  const pageUrl = contents.getURL()
  let site: string | null = null
  try {
    site = siteOf(new URL(pageUrl).hostname)
  } catch {
    site = null
  }
  if (!site) return { kind: 'left_page' }
  const readMail = options.readMail ?? readCodeMail
  if (!options.readMail && !hasCodeMailbox()) return { kind: 'no_mailbox' }
  const deadline = Date.now() + (options.waitMs ?? waitBudgetMs())
  const pollMs = options.pollMs ?? 3_000
  options.onWaiting?.(site)
  // Code emails land in a second or two: the first read waits that long, then every few seconds.
  await sleep(Math.min(pollMs, 2_000), options.signal)
  for (;;) {
    if (contents.isDestroyed() || contents.getURL() !== pageUrl) return { kind: 'left_page' }
    const decision = pickEmailedCode(
      await readMail({ domain: site, sinceMs: options.requestedAt }),
      { pageUrl, requestedAt: options.requestedAt }
    )
    if (decision.kind === 'conflict') return { kind: 'conflict', site, reason: decision.reason }
    if (decision.kind === 'code') {
      // Recheck: the page may have moved on while the mailbox answered.
      if (contents.isDestroyed() || contents.getURL() !== pageUrl) return { kind: 'left_page' }
      options.onSecret(decision.code)
      for (const char of field.indexes.length > 1 ? decision.code : '') options.onSecret(char)
      const result = await contents
        .executeJavaScriptInIsolatedWorld(FILL_WORLD, [
          { code: fillScript(field.indexes, decision.code) }
        ])
        .catch(() => 'none')
      return result === 'filled' ? { kind: 'filled', site } : { kind: 'left_page' }
    }
    if (Date.now() + pollMs > deadline) return { kind: 'no_code', site }
    await sleep(pollMs, options.signal)
  }
}

/** The step note for an outcome. Names the site, never the code. */
export function emailedCodeNote(outcome: EmailedCodeOutcome): string | null {
  switch (outcome.kind) {
    case 'filled':
      return `the code ${outcome.site} emailed was filled from your mailbox`
    case 'no_code':
      return `no code from ${outcome.site} arrived in your email; ask the person for the one-time code`
    case 'conflict':
      return `${outcome.reason} from ${outcome.site}; ask the person for the one-time code`
    case 'no_mailbox':
    case 'left_page':
      return null
  }
}
