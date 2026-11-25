import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { commitClick, commitKey } from '../browser-commit-gate'
import { SECRET_MASK, scrubSecretValues } from '../browser-secret-scrub'
import { browserShortcut } from '../browser-shortcuts'
import { chromeUserAgent } from '../browser-user-agent'
import { sandboxAllows, sandboxProfile, sandboxProfiles } from '../sandbox-profiles'
import { uniquePath } from '../browser-downloads'

describe('send, pay and delete ask first', () => {
  it.each([
    '- button "Send" [ref=e12]',
    '- button "Send now" [ref=e1]',
    '- button "Place your order" [ref=e2]',
    '- link "Pay $42.10" [ref=e3]',
    '- button "Delete forever" [ref=e4]',
    '- menuitem "Delete" [ref=e5]',
    '- button "Transfer money" [ref=e6]',
    '- button "Confirm booking" [ref=e7]',
    '- button "Submit application" [ref=f2e9]',
    '- button "Reply all" [ref=e8]',
    '- button "Cancel subscription" [ref=e9]'
  ])('gates %s', (line) => {
    expect(commitClick(line)).not.toBeNull()
  })

  it.each([
    '- button "Search" [ref=e1]',
    '- link "Sent mail" [ref=e2]',
    '- link "Payment methods" [ref=e3]',
    '- button "Add to cart" [ref=e4]',
    '- button "Accept all cookies" [ref=e5]',
    '- textbox "Send to" [ref=e6]',
    '- checkbox "Delete after reading" [ref=e7]',
    '- button "Next" [ref=e8]',
    '- button "Send a message to our support team about your order" [ref=e9]'
  ])('lets %s through', (line) => {
    expect(commitClick(line)).toBeNull()
  })

  it('names the commit in the question', () => {
    expect(commitClick('- button "Send" [ref=e12]')).toBe('Send')
    expect(commitClick(undefined)).toBeNull()
  })

  it('gates the composer send keys only', () => {
    expect(commitKey('Control+Enter')).toBe(true)
    expect(commitKey('Meta+Enter')).toBe(true)
    expect(commitKey('Enter')).toBe(false)
  })
})

describe('passwords never reach the models', () => {
  it('masks a filled password where the snapshot prints the field value', () => {
    const snapshot = [
      '- textbox "Email" [ref=e4]: test-user@offgrid-mail.test',
      '- textbox "Password" [ref=e5]: hunter2-correct',
      '- button "Sign in" [ref=e6]'
    ].join('\n')
    const out = scrubSecretValues(snapshot, ['hunter2-correct'])
    expect(out).not.toContain('hunter2-correct')
    expect(out).toContain(`- textbox "Password" [ref=e5]: ${SECRET_MASK}`)
    expect(out).toContain('test-user@offgrid-mail.test')
  })

  it('masks a secret quoted in a tool result and anywhere it is long enough', () => {
    expect(scrubSecretValues('typed "s3cr3t!" into e5', ['s3cr3t!'])).toBe(
      `typed "${SECRET_MASK}" into e5`
    )
    expect(scrubSecretValues('value=s3cr3t!&x=1', ['s3cr3t!'])).toBe(`value=${SECRET_MASK}&x=1`)
  })

  it('leaves ordinary words alone when a password is short', () => {
    const text = '- link "a" [ref=e1]\n- textbox "PIN" [ref=e2]: abc'
    expect(scrubSecretValues(text, ['abc'])).toBe(
      `- link "a" [ref=e1]\n- textbox "PIN" [ref=e2]: ${SECRET_MASK}`
    )
    expect(scrubSecretValues('the cabcab', ['abc'])).toBe('the cabcab')
  })

  it('treats regular-expression characters in a password as text', () => {
    expect(scrubSecretValues('pw: a.b*c(d)', ['a.b*c(d)'])).toBe(`pw: ${SECRET_MASK}`)
  })
})

describe('browser keys', () => {
  type Modifiers = Partial<Record<'meta' | 'control' | 'alt' | 'shift', boolean>>
  const key = (k: string, mods: Modifiers = {}): Parameters<typeof browserShortcut>[0] => ({
    type: 'keyDown' as const,
    key: k,
    code: '',
    meta: false,
    control: false,
    alt: false,
    shift: false,
    ...mods
  })

  it('uses Command on macOS and Control elsewhere', () => {
    expect(browserShortcut(key('t', { meta: true }), 'darwin')).toEqual({ kind: 'new-tab' })
    expect(browserShortcut(key('t', { control: true }), 'darwin')).toBeNull()
    expect(browserShortcut(key('t', { control: true }), 'linux')).toEqual({ kind: 'new-tab' })
    expect(browserShortcut(key('T', { control: true, shift: true }), 'win32')).toEqual({
      kind: 'reopen-closed-tab'
    })
  })

  it('maps history, downloads and developer tools per platform', () => {
    expect(browserShortcut(key('y', { meta: true }), 'darwin')).toEqual({
      kind: 'chrome',
      command: 'history'
    })
    expect(browserShortcut(key('h', { control: true }), 'linux')).toEqual({
      kind: 'chrome',
      command: 'history'
    })
    expect(browserShortcut(key('j', { control: true }), 'win32')).toEqual({
      kind: 'chrome',
      command: 'downloads'
    })
    expect(browserShortcut(key('F12'), 'linux')).toEqual({ kind: 'devtools' })
    expect(browserShortcut(key('i', { meta: true, alt: true }), 'darwin')).toEqual({
      kind: 'devtools'
    })
  })

  it('leaves plain typing and key releases to the page', () => {
    expect(browserShortcut(key('t'), 'darwin')).toBeNull()
    expect(
      browserShortcut({ ...key('t', { meta: true }), type: 'keyUp' as const }, 'darwin')
    ).toBeNull()
  })
})

describe('the built-in browser looks like Chrome to sites', () => {
  it('drops the Electron and app tokens, keeps Chrome', () => {
    const electron =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Off Grid AI Desktop/0.0.41 Chrome/142.0.7444.59 Electron/39.8.10 Safari/537.36'
    expect(chromeUserAgent(electron)).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.59 Safari/537.36'
    )
  })
})

describe('sandbox test profiles', () => {
  it('give every sandbox its own site, so the Vault never offers one login to another', () => {
    const hosts = sandboxProfiles().flatMap((profile) => profile.hosts)
    expect(new Set(hosts).size).toBe(hosts.length)
    expect(hosts.every((host) => host.endsWith('.test'))).toBe(true)
  })

  it('open only their own hosts over https', () => {
    const mail = sandboxProfile('mail')!
    expect(sandboxAllows(mail, 'https://offgrid-mail.test/inbox')).toBe(true)
    expect(sandboxAllows(mail, 'https://www.offgrid-mail.test/')).toBe(true)
    expect(sandboxAllows(mail, 'https://mail.google.com/')).toBe(false)
    expect(sandboxAllows(mail, 'https://offgrid-mail.test.evil.com/')).toBe(false)
    expect(sandboxAllows(mail, 'http://offgrid-mail.test/')).toBe(false)
    expect(sandboxProfile('nope')).toBeUndefined()
  })
})

describe('downloads', () => {
  it('never overwrites a file: it picks the next free name', () => {
    const taken = new Set([path.join('/d', 'report.pdf'), path.join('/d', 'report (1).pdf')])
    expect(uniquePath('/d', 'report.pdf', (file) => taken.has(file))).toBe(
      path.join('/d', 'report (2).pdf')
    )
    expect(uniquePath('/d', '../../etc/passwd', () => false)).toBe(path.join('/d', 'passwd'))
  })
})
