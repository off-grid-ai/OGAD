// @vitest-environment jsdom
/**
 * Settings → Tools → Web search on the computer: the person points searches at their own SearXNG
 * server or their own Tavily key, checks it with Test, and web_search then searches there.
 *
 * Real: the Settings panel, the web search IPC owner and its handlers, the SQLite settings table,
 * the secret store, the web_search tool. Controlled boundaries: Electron (safeStorage encrypts with a
 * visible marker) and the network (each origin answers what the test says).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React from 'react'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))
const tempProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-web-search-'))

vi.mock('electron', () => ({
  app: {
    getPath: () => tempProfile,
    getVersion: () => '0.0.130',
    getAppPath: () => process.cwd(),
    isPackaged: false,
    on: () => undefined
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      state.handlers.set(channel, handler)
    }
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, '')
  }
}))

const SEARXNG = 'https://search.home.lan'
const TAVILY = 'https://api.tavily.com'

/** The network: each origin answers what the test set; every request is recorded. */
const net = {
  answers: new Map<string, { status: number; body: string }>(),
  asked: [] as { url: string; headers: Record<string, string> }[]
}
function serve(origin: string, status: number, body: string): void {
  net.answers.set(origin, { status, body })
}

function handler<T>(channel: string): (...args: unknown[]) => Promise<T> {
  const registered = state.handlers.get(channel)
  expect(registered).toBeTypeOf('function')
  return (...args: unknown[]) => Promise.resolve(registered?.({}, ...args) as T)
}

async function openToolsSettings(): Promise<HTMLElement> {
  const { registerWebSearchIpc } = await import('../web-search-settings')
  registerWebSearchIpc()
  const tools = await import('../tools')
  const api = new Proxy(
    {
      isPro: false,
      platform: 'darwin',
      listTools: async () => tools.listTools(),
      // The panel's other owners, as a fresh profile answers them.
      getLlmSettings: async () => ({}),
      getSettings: async () => ({}),
      getModelCatalog: async () => ({ models: [] }),
      getActiveModel: async () => null,
      getTranscriptionInfo: async () => null,
      mcpList: async () => [],
      webSearchState: () => handler('web-search:state')(),
      webSearchSave: (value: unknown) => handler('web-search:save')(value),
      webSearchSetKey: (provider: string, key: string) => handler('web-search:set-key')(provider, key),
      webSearchRemoveKey: (provider: string) => handler('web-search:remove-key')(provider),
      webSearchTest: (value: unknown) => handler('web-search:test')(value)
    },
    {
      get: (target, property) =>
        property in target ? target[property as keyof typeof target] : async () => undefined
    }
  )
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  vi.stubGlobal('__OFFGRID_PRO__', false)
  const panelModule = '../../renderer/src/components/SettingsPanel'
  const { SettingsPanel } = (await import(/* @vite-ignore */ panelModule)) as {
    SettingsPanel: React.ComponentType<{ onClose: () => void; embedded?: boolean }>
  }
  render(React.createElement(SettingsPanel, { onClose: () => undefined, embedded: true }))
  // Reach Tools the way a person does: its tab.
  await userEvent.click(await screen.findByRole('radio', { name: /tools/i }))
  await screen.findByTestId('web-search-provider-builtin')
  return document.body
}

beforeEach(() => {
  state.handlers.clear()
  net.answers.clear()
  net.asked.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      net.asked.push({ url, headers: { ...init?.headers } })
      const reply = net.answers.get(new URL(url).origin) ?? { status: 503, body: '' }
      return { ok: reply.status < 400, status: reply.status, text: async () => reply.body }
    })
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

afterAll(async () => {
  const database = await import('../database')
  database.getDB().close()
  fs.rmSync(tempProfile, { recursive: true, force: true })
})

describe('Settings → Tools → Web search', () => {
  it('a SearXNG server set up and tested here is where web_search searches', async () => {
    serve(
      SEARXNG,
      200,
      JSON.stringify({
        results: [{ title: 'Achilles', url: 'https://example.org/achilles', content: 'Greek hero.' }]
      })
    )
    const section = await openToolsSettings()
    const user = userEvent.setup()

    // Before: built in, no address field.
    expect(within(section).getByTestId('web-search-provider-builtin').getAttribute('aria-checked')).toBe('true')
    expect(within(section).queryByTestId('web-search-address')).toBeNull()

    await user.click(within(section).getByTestId('web-search-provider-searxng'))
    expect(within(section).getByTestId('web-search-provider-searxng').getAttribute('aria-checked')).toBe('true')
    await user.type(within(section).getByTestId('web-search-address'), 'search.home.lan/')
    await user.click(within(section).getByTestId('web-search-test'))

    await waitFor(() => expect(within(section).getByTestId('web-search-result').textContent).toMatch(/Works/))
    expect((within(section).getByTestId('web-search-address') as HTMLInputElement).value).toBe(SEARXNG)
    expect(net.asked.map((a) => new URL(a.url).origin)).toEqual([SEARXNG])

    // The setting is saved where web_search reads it: a search goes to the server.
    net.asked.length = 0
    const { searchTheWeb } = await import('../web-search-settings')
    const { results, source } = await searchTheWeb('achilles')
    expect(source).toBe('searxng')
    expect(results[0]?.snippet).toBe('Greek hero.')
    expect(net.asked[0]?.url).toBe(`${SEARXNG}/search?q=achilles&format=json`)
  })

  it('a Tavily key is kept in the secret store, a refused key says why, and the key can be removed', async () => {
    serve(TAVILY, 401, '{"detail":"Unauthorized"}')
    const section = await openToolsSettings()
    const user = userEvent.setup()

    await user.click(within(section).getByTestId('web-search-provider-tavily'))
    await user.click(within(section).getByTestId('web-search-test'))
    await waitFor(() =>
      expect(within(section).getByTestId('web-search-result').textContent).toMatch(/Add your key first\./)
    )

    await user.type(within(section).getByTestId('web-search-key'), 'tvly-wrong')
    await user.click(within(section).getByTestId('web-search-test'))
    await waitFor(() =>
      expect(within(section).getByTestId('web-search-result').textContent).toMatch(
        /Did not answer.*the key or server refused the request/
      )
    )
    expect(net.asked.at(-1)?.headers.Authorization).toBe('Bearer tvly-wrong')
    // The key is saved, encrypted, and never shown again.
    expect(within(section).getByTestId('web-search-key-saved')).toBeTruthy()
    const { getSecret } = await import('../secrets')
    expect(getSecret('web-search.tavily.key')).toBe('tvly-wrong')

    await user.click(within(section).getByRole('button', { name: 'Remove key' }))
    await waitFor(() => expect(within(section).getByTestId('web-search-key')).toBeTruthy())
    expect(getSecret('web-search.tavily.key')).toBeNull()
  })
})

// brave_search: Brave is the network, like every other origin here; the tool, the settings and the
// built-in providers it falls back to all run for real.
const BRAVE = 'https://search.brave.com'
const DUCKDUCKGO = 'https://lite.duckduckgo.com'
const BRAVE_SEARCH_URL = `${BRAVE}/search?q=captcha&source=web`

const BRAVE_RESULTS_PAGE = `<!doctype html><html><head><title>how to solve a captcha - Brave Search</title></head>
<body><div class="snippet"><a href="https://example.com/solve-captcha">How to solve a CAPTCHA</a>
<p>A CAPTCHA asks you to prove you are human.</p></div>
<div class="snippet"><a href="https://docs.example.org/recaptcha">reCAPTCHA documentation</a></div></body></html>`

const BRAVE_CHALLENGE_PAGE = `<!doctype html><html><head><title>Brave Search</title></head>
<body><form id="captcha-form" action="/captcha/verify" method="post">
<div class="captcha-container"></div><button>Verify</button></form></body></html>`

const DUCKDUCKGO_PAGE = `<table><tr><td><a rel="nofollow" href="https://fallback.example/" class='result-link'>Fallback result</a></td></tr>
<tr><td class='result-snippet'>Found by the built-in search.</td></tr></table>`

async function braveSearch(): Promise<string> {
  const { setWebSearchSettings } = await import('../web-search-settings')
  setWebSearchSettings({ provider: 'builtin' })
  const { runTool } = await import('../tools')
  return (await runTool('brave_search', { query: 'how to solve a captcha' }, {}, [])).text
}

function askedOrigins(): string[] {
  return net.asked.map((request) => new URL(request.url).origin)
}

describe('isBraveChallenge', () => {
  it('is false for a results page that mentions CAPTCHA in its results', async () => {
    const { isBraveChallenge } = await import('../tools')
    expect(isBraveChallenge(200, BRAVE_SEARCH_URL, BRAVE_RESULTS_PAGE)).toBe(false)
  })

  it('is true for a refused status, the captcha page or captcha markup', async () => {
    const { isBraveChallenge } = await import('../tools')
    expect(isBraveChallenge(429, BRAVE_SEARCH_URL, '<html></html>')).toBe(true)
    expect(isBraveChallenge(200, `${BRAVE}/captcha?r=1`, '<html></html>')).toBe(true)
    expect(isBraveChallenge(200, BRAVE_SEARCH_URL, BRAVE_CHALLENGE_PAGE)).toBe(true)
    expect(
      isBraveChallenge(200, BRAVE_SEARCH_URL, '<div class="cf-turnstile" data-sitekey="x"></div>')
    ).toBe(true)
  })

  it('judges by the page when the response has no final URL', async () => {
    const { isBraveChallenge } = await import('../tools')
    expect(isBraveChallenge(200, '', BRAVE_RESULTS_PAGE)).toBe(false)
    expect(isBraveChallenge(200, '', BRAVE_CHALLENGE_PAGE)).toBe(true)
  })
})

describe('brave_search', () => {
  it('returns Brave results about captchas instead of falling back', async () => {
    serve(BRAVE, 200, BRAVE_RESULTS_PAGE)
    serve(DUCKDUCKGO, 200, DUCKDUCKGO_PAGE)
    const text = await braveSearch()
    expect(askedOrigins()).toEqual([BRAVE])
    expect(text).toContain('How to solve a CAPTCHA')
    expect(text).toContain('https://example.com/solve-captcha')
  })

  it('searches the way web_search does when Brave serves a challenge', async () => {
    serve(BRAVE, 200, BRAVE_CHALLENGE_PAGE)
    serve(DUCKDUCKGO, 200, DUCKDUCKGO_PAGE)
    const text = await braveSearch()
    expect(askedOrigins()).toEqual([BRAVE, DUCKDUCKGO])
    expect(text).toContain('Fallback result')
  })
})
