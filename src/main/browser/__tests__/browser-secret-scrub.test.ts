// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  READ_PASSWORD_VALUES_SCRIPT,
  SECRET_MASK,
  scrubSecretValues,
  TRACK_PASSWORD_FIELDS_SCRIPT
} from '../browser-secret-scrub'

/** Runs a page script the way the browser does: as source, in the page's global scope. */
const runInPage = <T>(script: string): T => (0, eval)(script) as T
const mutationsDelivered = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function passwordField(): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'password'
  document.body.append(input)
  return input
}

function typeInto(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('passwords in serialized text', () => {
  it('masks a password where a tool result escaped it as JSON', () => {
    const secret = 'pa"ss\\word'
    const result = JSON.stringify({ typed: secret, ref: 'e5' })
    const out = scrubSecretValues(result, [secret])
    expect(out).not.toContain('pa\\"ss')
    expect(out).toBe(JSON.stringify({ typed: SECRET_MASK, ref: 'e5' }))
  })

  it('masks a snapshot that quotes the value, also when the snapshot is itself JSON', () => {
    const secret = 'pa"ss'
    const snapshot = `- textbox "Password" [ref=e5]: ${JSON.stringify(secret)}`
    expect(scrubSecretValues(snapshot, [secret])).toBe(
      `- textbox "Password" [ref=e5]: "${SECRET_MASK}"`
    )
    const wrapped = JSON.stringify({ snapshot })
    const out = scrubSecretValues(wrapped, [secret])
    expect(out).not.toMatch(/pa\\+"ss/)
    expect(JSON.parse(out).snapshot).toBe(`- textbox "Password" [ref=e5]: "${SECRET_MASK}"`)
  })

  it('still masks the literal password', () => {
    expect(scrubSecretValues('- textbox "Password" [ref=e5]: pa"ss', ['pa"ss'])).toBe(
      `- textbox "Password" [ref=e5]: ${SECRET_MASK}`
    )
  })
})

describe('a password the person typed stays masked after the site shows it', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('reads the value of a field that turned from password into text', async () => {
    runInPage(TRACK_PASSWORD_FIELDS_SCRIPT)
    const input = passwordField()
    typeInto(input, 'typed-during-takeover')
    input.type = 'text'
    await mutationsDelivered()
    expect(runInPage<string[]>(READ_PASSWORD_VALUES_SCRIPT)).toContain('typed-during-takeover')
  })

  it('catches the switch to text even when the site set the value without an input event', async () => {
    runInPage(TRACK_PASSWORD_FIELDS_SCRIPT)
    const input = passwordField()
    input.value = 'set-by-the-site'
    input.setAttribute('type', 'text')
    await mutationsDelivered()
    expect(runInPage<string[]>(READ_PASSWORD_VALUES_SCRIPT)).toContain('set-by-the-site')
  })

  it('keeps reading what is typed into the shown field', async () => {
    const input = passwordField()
    runInPage(READ_PASSWORD_VALUES_SCRIPT)
    input.type = 'text'
    await mutationsDelivered()
    typeInto(input, 'typed-after-show')
    expect(runInPage<string[]>(READ_PASSWORD_VALUES_SCRIPT)).toContain('typed-after-show')
  })

  it('leaves fields that were never passwords out', () => {
    const email = document.createElement('input')
    email.type = 'email'
    document.body.append(email)
    typeInto(email, 'person@example.test')
    typeInto(passwordField(), 'hunter2-correct')
    const values = runInPage<string[]>(READ_PASSWORD_VALUES_SCRIPT)
    expect(values).toContain('hunter2-correct')
    expect(values).not.toContain('person@example.test')
  })
})
