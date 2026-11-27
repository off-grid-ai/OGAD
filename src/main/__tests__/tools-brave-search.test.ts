import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The network and the fallback search provider are the boundaries; the brave_search tool runs for real.
const fallback = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../web-search-settings', () => ({
  searchTheWeb: async () => {
    fallback.calls += 1
    return {
      results: [{ title: 'Fallback result', url: 'https://fallback.example/', snippet: '' }]
    }
  }
}))
vi.mock('../analytics', () => ({ track: () => {} }))

import { isBraveChallenge, runTool } from '../tools'

const SEARCH_URL = 'https://search.brave.com/search?q=captcha&source=web'

const RESULTS_PAGE = `<!doctype html><html><head><title>how to solve a captcha - Brave Search</title></head>
<body><div class="snippet"><a href="https://example.com/solve-captcha">How to solve a CAPTCHA</a>
<p>A CAPTCHA asks you to prove you are human.</p></div>
<div class="snippet"><a href="https://docs.example.org/recaptcha">reCAPTCHA documentation</a></div></body></html>`

const CHALLENGE_PAGE = `<!doctype html><html><head><title>Brave Search</title></head>
<body><form id="captcha-form" action="/captcha/verify" method="post">
<div class="captcha-container"></div><button>Verify</button></form></body></html>`

function respond(body: string, status: number, url = SEARCH_URL): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const res = new Response(body, { status })
      Object.defineProperty(res, 'url', { value: url })
      return res
    })
  )
}

async function braveSearch(): Promise<string> {
  return (await runTool('brave_search', { query: 'how to solve a captcha' }, {}, [])).text
}

beforeEach(() => {
  fallback.calls = 0
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isBraveChallenge', () => {
  it('is false for a results page that mentions CAPTCHA in its results', () => {
    expect(isBraveChallenge(200, SEARCH_URL, RESULTS_PAGE)).toBe(false)
  })

  it('is true for a refused status, the captcha page or captcha markup', () => {
    expect(isBraveChallenge(429, SEARCH_URL, '<html></html>')).toBe(true)
    expect(isBraveChallenge(200, 'https://search.brave.com/captcha?r=1', '<html></html>')).toBe(
      true
    )
    expect(isBraveChallenge(200, SEARCH_URL, CHALLENGE_PAGE)).toBe(true)
    expect(
      isBraveChallenge(200, SEARCH_URL, '<div class="cf-turnstile" data-sitekey="x"></div>')
    ).toBe(true)
  })

  it('judges by the page when the response has no final URL', () => {
    expect(isBraveChallenge(200, '', RESULTS_PAGE)).toBe(false)
    expect(isBraveChallenge(200, '', CHALLENGE_PAGE)).toBe(true)
  })
})

describe('brave_search', () => {
  it('returns Brave results about captchas instead of falling back', async () => {
    respond(RESULTS_PAGE, 200)
    const text = await braveSearch()
    expect(fallback.calls).toBe(0)
    expect(text).toContain('How to solve a CAPTCHA')
    expect(text).toContain('https://example.com/solve-captcha')
  })

  it('searches the way web_search does when Brave serves a challenge', async () => {
    respond(CHALLENGE_PAGE, 200)
    const text = await braveSearch()
    expect(fallback.calls).toBe(1)
    expect(text).toContain('Fallback result')
  })
})
