import { describe, expect, it } from 'vitest'
import {
  OFFGRID_FEATURES,
  formatGuide,
  newestUpdates,
  matchSitePages,
  pagesToRead,
  parsePageBody,
  parsePageSteps,
  parseSiteCards,
  parseDevTo,
  parseGithubReleases,
  parseOrgRepos,
  parseReddit
} from '../offgrid-guide'

describe('Off Grid AI guide', () => {
  it('reads public repos, skipping archived ones and junk', () => {
    expect(parseOrgRepos([{ name: 'mobile' }, { name: 'old', archived: true }, 3])).toEqual([
      'mobile'
    ])
    expect(parseOrgRepos({ message: 'rate limited' })).toEqual([])
  })

  it('reads published releases with their first note line', () => {
    const out = parseGithubReleases(
      [
        {
          name: 'v0.0.41',
          html_url: 'https://github.com/off-grid-ai/mobile/releases/v0.0.41',
          published_at: '2026-10-01T10:00:00Z',
          body: '## God\n\n* Chat or voice mode'
        },
        { name: 'draft', html_url: 'https://x', draft: true }
      ],
      'mobile'
    )
    expect(out).toEqual([
      {
        kind: 'release',
        title: 'v0.0.41',
        url: 'https://github.com/off-grid-ai/mobile/releases/v0.0.41',
        date: '2026-10-01T10:00:00.000Z',
        source: 'mobile release',
        summary: 'God'
      }
    ])
  })

  it('reads dev.to articles and subreddit posts', () => {
    expect(
      parseDevTo([
        { title: 'Local AI', url: 'https://dev.to/a/local', published_at: '2026-09-01T00:00:00Z' }
      ])[0]
    ).toMatchObject({ kind: 'article', source: 'dev.to', title: 'Local AI' })
    const posts = parseReddit({
      data: {
        children: [
          {
            data: { title: 'v41 is out', permalink: '/r/off_grid_ai/comments/1/', created_utc: 1 }
          },
          { data: { title: 'no link', permalink: 'https://evil.example' } }
        ]
      }
    })
    expect(posts).toHaveLength(1)
    expect(posts[0]!.url).toBe('https://www.reddit.com/r/off_grid_ai/comments/1/')
  })

  // The site's card, as every getoffgridai.co page renders it.
  const card = (href: string, title: string, desc: string, date = ''): string =>
    `<a class="guide-card article-result" href="${href}" data-topic="Sync" data-date="${date}">
      <span class="article-result-meta">Sync &amp; sharing · Phone</span>
      <span class="guide-card-title">${title}</span>
      <span class="guide-card-desc">${desc}</span></a>`

  it('reads guide, article, essay and about cards from any site page, once each, on the site only', () => {
    const html = [
      card('/guides/ios-setup/', 'iOS Setup', 'Install on <b>iPhone</b>.'),
      card('/articles/sync/', 'Sync &amp; share', 'Phone to computer.', '2026-09-29T08:30:06.548Z'),
      card('/articles/sync/', 'Duplicate', 'Seen on every page.'),
      card('/writing/context-gap/', 'Say &amp;quot;hi&amp;quot;', 'An essay.'),
      card('/mission/', 'Mission', 'Personal AI.'),
      card('https://getoffgridai.co.example.com/guides/x/', 'Look-alike host', 'No.'),
      '<a href="/guides/plain/">Not a card</a>'
    ].join('\n')
    expect(parseSiteCards(html)).toEqual([
      {
        kind: 'guide',
        title: 'iOS Setup',
        url: 'https://getoffgridai.co/guides/ios-setup/',
        date: undefined,
        source: 'getoffgridai.co',
        summary: 'Install on iPhone.'
      },
      {
        kind: 'article',
        title: 'Sync & share',
        url: 'https://getoffgridai.co/articles/sync/',
        date: '2026-09-29T08:30:06.548Z',
        source: 'getoffgridai.co',
        summary: 'Phone to computer.'
      },
      // Decoded once: the page's text says &quot; literally, so the title does too.
      expect.objectContaining({ kind: 'essay', title: 'Say &quot;hi&quot;' }),
      expect.objectContaining({ kind: 'about', title: 'Mission' })
    ])
  })

  it("reads the quick start's numbered steps, and nothing after them", () => {
    const html = `<h1>Quick Start</h1><h2>1. Install</h2><p>Get the <a href="/download/">app</a> .</p>
      <h2>2. Prepare a model</h2><p>Open <b>Models</b>.</p><h2>Next</h2><p>More guides.</p>`
    expect(parsePageSteps(html)).toBe('1. Install: Get the app.\n2. Prepare a model: Open Models.')
    expect(parsePageSteps('<h2>About</h2><p>No steps.</p>')).toBe('')
  })

  it('finds the pages about a task, title words first, newest on a tie', () => {
    const pages = parseSiteCards(
      [
        card('/articles/a/', 'Pair your phone', 'Sync chats.', '2026-01-01T00:00:00Z'),
        card('/articles/b/', 'Sync attachments', 'Phone to computer.', '2026-02-01T00:00:00Z'),
        card('/articles/c/', 'Sync history', 'Across devices.', '2026-03-01T00:00:00Z'),
        card('/guides/d/', 'Image generation', 'Make pictures.')
      ].join('')
    )
    expect(matchSitePages(pages, 'sync attachments').map((p) => p.title)).toEqual([
      'Sync attachments',
      'Sync history',
      'Pair your phone'
    ])
    expect(matchSitePages(pages, 'a')).toEqual([])
  })

  it('gives the quick start, an overview of the library, or the pages that match the question', () => {
    const pages = parseSiteCards(
      [
        card('/guides/ios-setup/', 'iOS Setup', 'Install on iPhone.'),
        card('/articles/sync/', 'Sync attachments', 'Phone to computer.', '2026-09-29T00:00:00Z'),
        card('/writing/context-gap/', 'The context gap', 'An essay.'),
        card('/vision/', 'Vision', 'Your digital twin.')
      ].join('')
    )
    const site = { steps: '1. Install: Get the app.', pages }
    const overview = formatGuide([], [], site)
    for (const part of [
      'Quick start (https://getoffgridai.co/quick-start/):\n1. Install: Get the app.',
      'About Off Grid AI:\n- Vision',
      'Guides:\n- iOS Setup\n   https://getoffgridai.co/guides/ios-setup/\n   Install on iPhone.',
      'Newest articles:\n- Sync attachments (2026-09-29)',
      'Perspectives:\n- The context gap'
    ]) {
      expect(overview).toContain(part)
    }
    const answer = formatGuide([], [], site, 'sync attachments')
    expect(answer).toContain(
      'Pages on getoffgridai.co about "sync attachments":\n- Sync attachments'
    )
    expect(answer).not.toContain('Perspectives:')
    expect(formatGuide([], [], site, 'quantum')).toContain(
      'No page on getoffgridai.co matched "quantum".'
    )
  })

  it("reads a page's own content in full, keeping its headings, lists, tables and links", () => {
    const html = `<nav>Site menu</nav><article class="content" data-pagefind-body>
      <h2>iOS Setup</h2><p>Run a model on your iPhone.</p>
      <ul><li>iPhone 12 or newer</li><li>iOS 17 or later</li></ul>
      <table><tr><td><a href="https://getoffgridai.co/desktop/">Get OGAD</a></td><td>Free</td></tr></table>
      <script>track()</script><p>Works offline &amp; private .</p></article><footer>Footer</footer>`
    expect(parsePageBody(html)).toBe(
      [
        '## iOS Setup',
        'Run a model on your iPhone.',
        '- iPhone 12 or newer',
        '- iOS 17 or later',
        'Get OGAD (https://getoffgridai.co/desktop/) | Free',
        'Works offline & private.'
      ].join('\n')
    )
    expect(parsePageBody('<main>No indexed article here</main>')).toBe('')
    expect(parsePageBody(html, 20)).toBe('## iOS Setup\nRun...')
  })

  it('removes excluded elements that appear when nested markup is removed', () => {
    const html = `<article data-pagefind-body><scr<script>nested()</script>ipt>hidden()</script><p>Visible content.</p></article>`
    expect(parsePageBody(html)).toBe('Visible content.')
  })

  it('reads in full the pages that answer the question, or Mission and Vision without one', () => {
    const pages = parseSiteCards(
      [
        card('/articles/a/', 'Sync attachments', 'Phone to computer.'),
        card('/articles/b/', 'Sync history', 'Across devices.'),
        card('/articles/c/', 'Sync settings', 'Choose what syncs.'),
        card('/articles/d/', 'Sync projects', 'Knowledge bases.'),
        card('/mission/', 'Mission', 'Personal AI.')
      ].join('')
    )
    expect(pagesToRead(pages, 'sync')).toHaveLength(3)
    expect(pagesToRead(pages, '').map((p) => p.title)).toEqual(['Mission'])
    const text = formatGuide(
      [],
      [],
      {
        steps: '',
        pages,
        bodies: {
          'https://getoffgridai.co/articles/a/': '## Attachments\nThey sync after pairing.'
        }
      },
      'sync attachments'
    )
    expect(text).toContain(
      'Sync attachments (https://getoffgridai.co/articles/a/), in full:\n## Attachments\nThey sync after pairing.'
    )
  })

  it('orders news newest first, undated last, once each, and says what it could not reach', () => {
    const a = { kind: 'article' as const, title: 'A', url: 'u1', source: 's', date: '2026-01-01' }
    const b = { kind: 'release' as const, title: 'B', url: 'u2', source: 's', date: '2026-02-01' }
    const c = { kind: 'article' as const, title: 'C', url: 'u3', source: 's' }
    expect(newestUpdates([c, a, b, a]).map((u) => u.title)).toEqual(['B', 'A', 'C'])
    const text = formatGuide([b], ['dev.to'])
    expect(text.startsWith(OFFGRID_FEATURES)).toBe(true)
    expect(text).toContain('- [s] B (2026-02-01)\n   u2')
    expect(text).toContain('Could not reach: dev.to.')
    expect(formatGuide([], [])).toContain('No recent posts could be read.')
  })
})
