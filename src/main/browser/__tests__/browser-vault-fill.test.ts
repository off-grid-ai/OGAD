// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://shop.example.test/login" }
import type { WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOOKS, registerHook, unregisterHook } from '../../bootstrap/hookRegistry'
import { fillVaultLogin } from '../browser-vault-fill'

/** The Vault's answer to a reveal: the login for the site it was asked about. */
const vault = vi.fn(async (request: { type: string }) =>
  request.type === 'reveal'
    ? { type: 'credential', username: 'person@example.test', password: 'hunter2-correct' }
    : { type: 'error', message: 'unexpected' }
)

/** Electron's WebContents at its boundary: the committed URL, and the fill run in this document. */
function page(committedUrl: string): WebContents {
  return {
    getURL: () => committedUrl,
    executeJavaScriptInIsolatedWorld: async (_world: number, scripts: { code: string }[]) =>
      (0, eval)(scripts.map((script) => script.code).join('\n')) as unknown
  } as unknown as WebContents
}

function loginForm(): { user: HTMLInputElement; pass: HTMLInputElement } {
  const form = document.createElement('form')
  const user = document.createElement('input')
  user.type = 'email'
  user.name = 'email'
  const pass = document.createElement('input')
  pass.type = 'password'
  form.append(user, pass)
  document.body.append(form)
  return { user, pass }
}

describe('the Vault fills only the site it revealed the login for', () => {
  beforeEach(() => {
    registerHook(HOOKS.extensionVaultRequest, vault as never)
    // jsdom lays nothing out; give fields a size so they count as visible.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 120,
      height: 24
    } as DOMRect)
  })

  afterEach(() => {
    unregisterHook(HOOKS.extensionVaultRequest)
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('fills the login on the page it was revealed for', async () => {
    const { user, pass } = loginForm()
    const outcome = await fillVaultLogin(page('https://shop.example.test/login'), 'login-1')
    expect(outcome).toEqual({ ok: true, username: 'person@example.test' })
    expect(user.value).toBe('person@example.test')
    expect(pass.value).toBe('hunter2-correct')
  })

  it('fills nothing when another site loaded before the fill ran', async () => {
    // The committed URL still says bank.example.test; the document the fill runs in is the shop's.
    const { user, pass } = loginForm()
    const outcome = await fillVaultLogin(page('https://bank.example.test/login'), 'login-1')
    expect(outcome).toEqual({ ok: false, reason: 'origin_mismatch' })
    expect(user.value).toBe('')
    expect(pass.value).toBe('')
    expect(vault).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'reveal', origin: 'https://bank.example.test' }),
      expect.anything()
    )
  })

  it('reports no form when the page has nothing to fill', async () => {
    const outcome = await fillVaultLogin(page('https://shop.example.test/login'), 'login-1')
    expect(outcome).toEqual({ ok: false, reason: 'no_form' })
  })
})
