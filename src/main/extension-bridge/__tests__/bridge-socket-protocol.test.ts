import { describe, expect, it } from 'vitest'
import { deriveSessionKey, generateKeyPair, open, seal } from '../bridge-protocol'
import {
  createChannel,
  isUncertainPageResult,
  LEGACY_PAGE_NO_ANSWER,
  helloAad,
  linkName,
  newNonce,
  parseCommand,
  parseHello,
  parseReady,
  parseUpstream,
  readyAad,
  type SealedChannel
} from '../bridge-socket-protocol'

async function sharedKey(): Promise<CryptoKey> {
  const a = await generateKeyPair()
  const b = await generateKeyPair(true)
  return deriveSessionKey(a.privateKey, b.publicKey, 'device000001')
}

async function pair(): Promise<{
  key: CryptoKey
  browser: SealedChannel
  desktop: SealedChannel
}> {
  const key = await sharedKey()
  const link = linkName(newNonce(), newNonce())
  const deviceId = 'device000001'
  return {
    key,
    browser: createChannel({ key, deviceId, link, role: 'browser' }),
    desktop: createChannel({ key, deviceId, link, role: 'desktop' })
  }
}

describe('socket handshake', () => {
  it('accepts a fresh hello and refuses a stale or malformed one', () => {
    const nonce = newNonce()
    expect(parseHello({ nonce, ts: 1000 }, 1000)).toEqual({ nonce, ts: 1000 })
    expect(parseHello({ nonce, ts: 0 }, 1000 + 120_001)).toBeNull()
    expect(parseHello({ nonce: 'short', ts: 1000 }, 1000)).toBeNull()
    expect(parseHello(null, 0)).toBeNull()
    expect(parseReady({ nonce })).toEqual({ nonce })
    expect(parseReady({ nonce: 1 })).toBeNull()
  })

  it('binds the desktop answer to the browser nonce', async () => {
    const key = await sharedKey()
    const browserNonce = newNonce()
    const sealed = await seal(key, readyAad('device000001', browserNonce), { nonce: newNonce() })
    expect(await open(key, readyAad('device000001', newNonce()), sealed)).toBeNull()
    expect(await open(key, helloAad('device000001'), sealed)).toBeNull()
    expect(parseReady(await open(key, readyAad('device000001', browserNonce), sealed))).not.toBe(
      null
    )
  })
})

describe('createChannel', () => {
  it('carries messages both ways, in order', async () => {
    const { browser, desktop } = await pair()
    const down1 = await desktop.seal({ id: 1, op: 'tabs.list', args: {} })
    const down2 = await desktop.seal({ id: 2, op: 'tabs.list', args: {} })
    expect(await browser.open(down1)).toEqual({ id: 1, op: 'tabs.list', args: {} })
    expect(await browser.open(down2)).toMatchObject({ id: 2 })
    expect(await desktop.open(await browser.seal({ id: 1, ok: true, result: [] }))).toMatchObject({
      ok: true
    })
  })

  it('nothing readable on the wire', async () => {
    const { desktop } = await pair()
    const frame = await desktop.seal({
      op: 'cdp.send',
      args: { method: 'Input.insertText', text: 'secret plan' }
    })
    expect(frame).not.toMatch(/secret|Input|cdp/)
    expect(Object.keys(JSON.parse(frame) as object).sort()).toEqual(['c', 'n'])
  })

  it('drops a repeated, reordered, reflected or foreign frame, and stays dropped', async () => {
    const { browser, desktop, key } = await pair()
    const first = await desktop.seal({ n: 1 })
    const second = await desktop.seal({ n: 2 })
    expect(await browser.open(second)).toBeNull() // out of order
    expect(await browser.open(first)).toBeNull() // the link is broken now

    const fresh = await pair()
    const frame = await fresh.desktop.seal({ n: 1 })
    expect(await fresh.browser.open(frame)).toEqual({ n: 1 })
    expect(await fresh.browser.open(frame)).toBeNull() // replay

    const again = await pair()
    const up = await again.browser.seal({ n: 1 })
    expect(await again.browser.open(up)).toBeNull() // its own frame reflected back

    const other = createChannel({ key, deviceId: 'device000001', link: 'x.y', role: 'browser' })
    expect(await other.open(await desktop.seal({ n: 3 }))).toBeNull() // another link
    expect(await createChannel({ key, deviceId: 'd', link: 'l', role: 'browser' }).open('{')).toBe(
      null
    )
  })
})

describe('message shapes', () => {
  it('validates the child tab event exactly', () => {
    const data = { tabId: 8, openerTabId: 7, url: '', title: '' }
    const event = { event: 'tab.opened', tabId: 8, data }
    expect(parseUpstream(event)).toEqual(event)
    expect(parseUpstream({ ...event, data: { ...data, tabId: 9 } })).toBeNull()
    expect(parseUpstream({ ...event, data: { tabId: 8, url: '', title: '' } })).toBeNull()
    for (const invalid of [
      { ...data, openerTabId: 1.5 },
      { ...data, openerTabId: '7' },
      { ...data, url: null },
      { ...data, title: undefined }
    ])
      expect(parseUpstream({ ...event, data: invalid })).toBeNull()
  })

  it('accepts only known commands', () => {
    expect(parseCommand({ id: 3, op: 'cdp.send', args: { method: 'Page.navigate' } })).toEqual({
      id: 3,
      op: 'cdp.send',
      args: { method: 'Page.navigate' }
    })
    expect(parseCommand({ id: 3, op: 'eval', args: {} })).toBeNull()
    expect(parseCommand({ id: 'x', op: 'tabs.list', args: {} })).toBeNull()
    expect(parseCommand({ id: 1, op: 'tabs.list' })).toBeNull()
  })

  it('accepts replies and known events from the browser', () => {
    expect(parseUpstream({ id: 1, ok: true, result: 5 })).toEqual({ id: 1, ok: true, result: 5 })
    expect(parseUpstream({ id: 1, ok: false, error: 'no' })).toEqual({
      id: 1,
      ok: false,
      error: 'no'
    })
    expect(parseUpstream({ id: 1, ok: false })).toBeNull()
    expect(
      parseUpstream({ event: 'cdp.event', tabId: 4, data: { method: 'Page.loadEventFired' } })
    ).toMatchObject({ event: 'cdp.event', tabId: 4 })
    expect(parseUpstream({ event: 'ping', tabId: 0, data: {} })).toMatchObject({ event: 'ping' })
    expect(parseUpstream({ event: 'shell', tabId: 4, data: {} })).toBeNull()
    expect(parseUpstream('x')).toBeNull()
  })
})

describe('uncertain page results', () => {
  it('preserves the explicit outcome in a socket reply', () => {
    const result = { text: 'The action may have run.', isError: false, uncertain: true as const }
    expect(parseUpstream({ id: 1, ok: true, result })).toEqual({ id: 1, ok: true, result })
    expect(isUncertainPageResult(result)).toBe(true)
  })

  it('recognizes the legacy no-answer error only', () => {
    expect(LEGACY_PAGE_NO_ANSWER).toBe('The page did not answer.')
    expect(isUncertainPageResult({ text: LEGACY_PAGE_NO_ANSWER, isError: true })).toBe(true)
    expect(isUncertainPageResult({ text: 'Permission denied', isError: true })).toBe(false)
    expect(isUncertainPageResult({ text: 'Clicked', isError: false })).toBe(false)
  })
})
