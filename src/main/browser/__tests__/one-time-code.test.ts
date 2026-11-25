import { describe, expect, it } from 'vitest'
import {
  extractOneTimeCodes,
  findCodeField,
  pickEmailedCode,
  senderDomain,
  senderMatchesSite,
  type CodeFieldCandidate,
  type CodeMail
} from '../one-time-code'

function input(index: number, over: Partial<CodeFieldCandidate> = {}): CodeFieldCandidate {
  return {
    index,
    type: 'text',
    autocomplete: '',
    hint: '',
    maxLength: -1,
    hasValue: false,
    ...over
  }
}

describe('findCodeField', () => {
  it('finds autocomplete=one-time-code', () => {
    expect(findCodeField([input(0, { autocomplete: 'one-time-code' })], '')).toEqual({
      indexes: [0],
      filled: false
    })
  })

  it('finds a field named for a verification code', () => {
    const fields = [input(0, { hint: 'q Search' }), input(1, { hint: 'otp Verification code' })]
    expect(findCodeField(fields, '')?.indexes).toEqual([1])
  })

  it('takes a plain "code" field only when the page says a code was sent', () => {
    const fields = [input(0, { hint: 'code Code' })]
    expect(findCodeField(fields, 'Welcome back')).toBeNull()
    expect(
      findCodeField(fields, 'We emailed a 6-digit code to a••••@example.com')?.indexes
    ).toEqual([0])
  })

  it('ignores promo, postal and card codes', () => {
    const page = 'We sent you a code'
    expect(findCodeField([input(0, { hint: 'promo Promo code' })], page)).toBeNull()
    expect(findCodeField([input(0, { hint: 'zip Postal code' })], page)).toBeNull()
    expect(
      findCodeField([input(0, { autocomplete: 'cc-csc', hint: 'Security code' })], page)
    ).toBeNull()
  })

  it('never treats a password field as a code field', () => {
    expect(findCodeField([input(0, { type: 'password', hint: 'Passcode' })], '')).toBeNull()
  })

  it('finds a row of single-digit boxes on a page that says a code was sent', () => {
    const boxes = [0, 1, 2, 3, 4, 5].map((i) => input(i + 1, { maxLength: 1 }))
    const field = findCodeField([input(0, { hint: 'email' }), ...boxes], 'Enter the code we sent')
    expect(field).toEqual({ indexes: [1, 2, 3, 4, 5, 6], filled: false })
    expect(findCodeField(boxes, 'Choose your seats')).toBeNull()
  })

  it('reports a field that already holds a value', () => {
    expect(
      findCodeField([input(0, { autocomplete: 'one-time-code', hasValue: true })], '')?.filled
    ).toBe(true)
  })
})

describe('extractOneTimeCodes', () => {
  it.each([
    [
      'Your Harbour Bank code',
      'Your verification code is 482913. It expires in 10 minutes.',
      '482913'
    ],
    ['Sign in', 'Use code 482913 to sign in.', '482913'],
    [
      'Atlantic Air',
      'Your sign-in code:\n\n  731 044\n\nIf this was not you, ignore it.',
      '731044'
    ],
    ['482913 is your Harbour Bank verification code', '', '482913'],
    ['Security alert', 'Your one-time passcode for Harbour Bank is: 5521', '5521'],
    ['Confirm it is you', 'Enter this code below:\n\nK7Q2PX\n', 'K7Q2PX'],
    ['Verify', 'Here is your code\n\n904417\n\n© 2026 Example Inc.', '904417'],
    ['Code', 'Your code for account 12345678 is 482913', '482913']
  ])('reads %s', (subject, text, code) => {
    expect(extractOneTimeCodes(subject, text)).toEqual([code])
  })

  it('reads nothing from mail that is not about a code', () => {
    expect(extractOneTimeCodes('Invoice NW-2291', 'Amount due 4,200 by 2026-12-01')).toEqual([])
    expect(extractOneTimeCodes('Lunch', 'See you at 1230 on Wednesday')).toEqual([])
  })

  it('does not read words or expiry minutes as the code', () => {
    expect(extractOneTimeCodes('Your code', 'This code expires in 10 minutes.')).toEqual([])
  })

  it('returns both when one email holds two codes', () => {
    expect(extractOneTimeCodes('Codes', 'Your code is 111111. Backup code: 222222').sort()).toEqual(
      ['111111', '222222']
    )
  })
})

describe('sender matching', () => {
  it('reads the domain of a From header', () => {
    expect(senderDomain('Harbour Bank <no-reply@offgrid-bank.test>')).toBe('offgrid-bank.test')
    expect(senderDomain('alerts@Mail.Example.COM')).toBe('mail.example.com')
    expect(senderDomain('nobody')).toBeNull()
  })

  it('matches the page site by registrable domain', () => {
    expect(
      senderMatchesSite('no-reply@offgrid-bank.test', 'https://offgrid-bank.test/verify')
    ).toBe(true)
    expect(senderMatchesSite('codes@mail.bank.co.uk', 'https://login.bank.co.uk/otp')).toBe(true)
  })

  it('refuses mail from any other site', () => {
    expect(senderMatchesSite('no-reply@offgrid-air.test', 'https://offgrid-bank.test/verify')).toBe(
      false
    )
    // Lookalikes and a shared public suffix are different sites.
    expect(senderMatchesSite('no-reply@amazon.com', 'https://amazon.xyz/signin')).toBe(false)
    expect(senderMatchesSite('a@other.co.uk', 'https://bank.co.uk/')).toBe(false)
    expect(senderMatchesSite('a@bank.com.evil.io', 'https://bank.com/')).toBe(false)
  })
})

describe('pickEmailedCode', () => {
  const pageUrl = 'https://offgrid-bank.test/verify'
  const requestedAt = 1_000_000
  const mail = (over: Partial<CodeMail>): CodeMail => ({
    from: 'Harbour Bank <no-reply@offgrid-bank.test>',
    subject: 'Your sign-in code',
    text: 'Your code is 482913',
    receivedAt: requestedAt + 5_000,
    ...over
  })

  it('takes the code from fresh mail of the site that asked', () => {
    expect(pickEmailedCode([mail({})], { pageUrl, requestedAt })).toEqual({
      kind: 'code',
      code: '482913'
    })
  })

  it('ignores mail received before the code was asked for', () => {
    expect(
      pickEmailedCode([mail({ receivedAt: requestedAt - 1 })], { pageUrl, requestedAt })
    ).toEqual({ kind: 'none' })
  })

  it('ignores codes from other sites', () => {
    expect(
      pickEmailedCode([mail({ from: 'no-reply@offgrid-air.test' })], { pageUrl, requestedAt })
    ).toEqual({ kind: 'none' })
  })

  it('takes the newest code when a resend came well after', () => {
    const older = mail({ text: 'Your code is 111111', receivedAt: requestedAt + 1_000 })
    const newer = mail({ text: 'Your code is 222222', receivedAt: requestedAt + 60_000 })
    expect(pickEmailedCode([older, newer], { pageUrl, requestedAt })).toEqual({
      kind: 'code',
      code: '222222'
    })
  })

  it('asks the person when two different codes arrive together', () => {
    const a = mail({ text: 'Your code is 111111', receivedAt: requestedAt + 1_000 })
    const b = mail({ text: 'Your code is 222222', receivedAt: requestedAt + 3_000 })
    expect(pickEmailedCode([a, b], { pageUrl, requestedAt }).kind).toBe('conflict')
  })

  it('asks the person when one email holds two codes', () => {
    const both = mail({ text: 'Your code is 111111. Backup code: 222222' })
    expect(pickEmailedCode([both], { pageUrl, requestedAt }).kind).toBe('conflict')
  })
})
