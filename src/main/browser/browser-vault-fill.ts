import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { callHookAsync, hasHook, HOOKS } from '../bootstrap/hookRegistry'
import type {
  BrowserFillOutcome,
  BrowserVaultLogin,
  BrowserVaultState
} from '../../shared/browser-library'

/**
 * The Vault, for the built-in browser. It asks the same hook the paired browser extension uses
 * (HOOKS.extensionVaultRequest, Pro's extension-vault.ts), so the rules are the Vault's own:
 * answers only while unlocked, and a password goes only to a page on the login's own site
 * (registrable domain, https). Free builds have no Vault and see 'unavailable'.
 *
 * The password travels main → that page's form, in an isolated world. It is never sent to the
 * browser chrome, never logged, and browser-secret-scrub.ts keeps it out of what models read.
 */

const KINDS = { kinds: ['login', 'authenticator'] as const }
/** One isolated world for the fill, apart from the page's scripts and Electron's own. */
export const FILL_WORLD = 1_847

type VaultReply =
  | { type: 'matches'; entries: { uuid: string; title: string; username: string }[] }
  | { type: 'credential'; username: string; password: string; totp?: string }
  | { type: 'denied'; reason: string }
  | { type: 'error'; message: string }

async function ask(request: Record<string, unknown>): Promise<VaultReply | null> {
  if (!hasHook(HOOKS.extensionVaultRequest)) return null
  const reply = await callHookAsync<VaultReply>(
    HOOKS.extensionVaultRequest,
    { id: randomUUID(), ...request },
    KINDS
  )
  return reply ?? null
}

function pageOrigin(url: string): string | null {
  try {
    const parsed = new URL(url)
    return /^https?:$/.test(parsed.protocol) ? parsed.origin : null
  } catch {
    return null
  }
}

/** Which Vault logins belong to the page's site. Names and usernames only. */
export async function vaultStateFor(url: string): Promise<BrowserVaultState> {
  const origin = pageOrigin(url)
  if (!origin) return { state: 'none' }
  const reply = await ask({ type: 'match', origin }).catch(() => null)
  if (!reply) return { state: 'unavailable' }
  if (reply.type === 'denied' && reply.reason === 'locked') return { state: 'locked' }
  if (reply.type !== 'matches' || reply.entries.length === 0) return { state: 'none' }
  const logins: BrowserVaultLogin[] = reply.entries.map(({ uuid, title, username }) => ({
    uuid,
    title,
    username
  }))
  return { state: 'available', logins }
}

/**
 * Runs in the page's isolated world. Fills the visible password field and the username field
 * before it, or, on a username-first page (Google, Microsoft), the visible username field alone.
 * Sets values through the native setter and fires input/change so React and Vue forms see them.
 */
function fillScript(username: string, password: string, totp: string): string {
  return `(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.disabled && !el.readOnly
  }
  const set = (el, value) => {
    const proto = Object.getPrototypeOf(el)
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    el.focus()
    if (setter) setter.call(el, value); else el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const inputs = Array.from(document.querySelectorAll('input')).filter(visible)
  const isUser = (el) => ['email', 'text', 'tel', ''].includes(el.type) &&
    /user|email|login|account|identifier|phone|name/i.test([el.name, el.id, el.autocomplete, el.getAttribute('aria-label'), el.placeholder].join(' '))
  const isCode = (el) => /one-time-code|otp|totp|2fa|verification|passcode/i.test([el.name, el.id, el.autocomplete, el.getAttribute('aria-label'), el.placeholder].join(' '))
  const code = inputs.find((el) => el.type !== 'password' && isCode(el))
  if (code && ${JSON.stringify(totp)}) { set(code, ${JSON.stringify(totp)}); return 'code' }
  const pass = inputs.find((el) => el.type === 'password' && !/new-password/.test(el.autocomplete))
  if (pass) {
    const before = inputs.slice(0, inputs.indexOf(pass)).filter((el) => el.type !== 'password' && el.type !== 'hidden' && el.type !== 'checkbox' && el.type !== 'radio')
    const user = before.reverse().find((el) => (el.form === pass.form) && (isUser(el) || el.type === 'email' || el.type === 'text'))
    if (user && ${JSON.stringify(username)} && !user.value) set(user, ${JSON.stringify(username)})
    if (${JSON.stringify(password)}) set(pass, ${JSON.stringify(password)})
    return 'login'
  }
  const user = inputs.find(isUser) || inputs.find((el) => el.type === 'email')
  if (user && ${JSON.stringify(username)}) { set(user, ${JSON.stringify(username)}); return 'username' }
  return 'none'
})()`
}

/** Reveal the login for the page's site and fill it. The caller never sees the secret. */
export async function fillVaultLogin(
  contents: WebContents,
  uuid: string,
  onSecret?: (secret: string) => void
): Promise<BrowserFillOutcome> {
  const origin = pageOrigin(contents.getURL())
  if (!origin) return { ok: false, reason: 'origin_mismatch' }
  const reply = await ask({ type: 'reveal', uuid, origin }).catch(() => null)
  if (!reply) return { ok: false, reason: 'unavailable' }
  if (reply.type === 'denied') {
    return {
      ok: false,
      reason:
        reply.reason === 'locked'
          ? 'locked'
          : reply.reason === 'origin_mismatch'
            ? 'origin_mismatch'
            : 'no_login'
    }
  }
  if (reply.type !== 'credential') return { ok: false, reason: 'unavailable' }
  // Recheck: the page may have navigated to another site while the Vault answered.
  if (pageOrigin(contents.getURL()) !== origin) return { ok: false, reason: 'origin_mismatch' }
  if (reply.password) onSecret?.(reply.password)
  if (reply.totp) onSecret?.(reply.totp)
  const result = (await contents
    .executeJavaScriptInIsolatedWorld(FILL_WORLD, [
      { code: fillScript(reply.username, reply.password, reply.totp ?? '') }
    ])
    .catch(() => 'none')) as string
  return result === 'none'
    ? { ok: false, reason: 'no_form' }
    : { ok: true, username: reply.username }
}

/** Does the page show a sign-in form? Read in the isolated world; reads no values. */
export async function hasLoginForm(contents: WebContents): Promise<boolean> {
  const found = await contents
    .executeJavaScriptInIsolatedWorld(FILL_WORLD, [
      {
        code: `(() => Array.from(document.querySelectorAll('input')).some((el) => {
          const r = el.getBoundingClientRect()
          if (r.width === 0 || r.height === 0) return false
          if (el.type === 'password') return !/new-password/.test(el.autocomplete)
          return /username|email|identifier|one-time-code/.test(el.autocomplete)
        }))()`
      }
    ])
    .catch(() => false)
  return found === true
}
