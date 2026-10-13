// The offgrid_guide tool: what Off Grid AI does, how to do things in it, and what is new, from
// getoffgridai.co (quick start, guides, articles, perspectives, ethos), its public release notes
// and its community. Reads public pages only, and only when God or chat calls it.
// Wiring only: parsing and formatting are in shared/offgrid-guide.ts, tested.

import {
  OFFGRID_SITE_PAGES,
  OFFGRID_SOURCES,
  formatGuide,
  newestUpdates,
  pagesToRead,
  parsePageBody,
  parsePageSteps,
  parseSiteCards,
  type OffgridSite,
  parseDevTo,
  parseGithubReleases,
  parseOrgRepos,
  parseReddit,
  type OffgridUpdate
} from '../../shared/offgrid-guide'

const HEADERS = { 'User-Agent': 'OffGridAI-Desktop', Accept: 'application/json, text/html' }
// Release notes from the most recently pushed public repositories.
const RELEASE_REPOS = 4

async function get(url: string): Promise<Response> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8_000) })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  return res
}

async function releases(): Promise<OffgridUpdate[]> {
  const repos = parseOrgRepos(await (await get(OFFGRID_SOURCES.githubOrg)).json())
  const lists = await Promise.all(
    repos
      .slice(0, RELEASE_REPOS)
      .map(async (repo) =>
        parseGithubReleases(
          await (await get(OFFGRID_SOURCES.releases(repo))).json().catch(() => []),
          repo
        )
      )
  )
  return lists.flat()
}

const SOURCES: ReadonlyArray<{ name: string; read: () => Promise<OffgridUpdate[]> }> = [
  { name: 'GitHub releases', read: releases },
  { name: 'dev.to', read: async () => parseDevTo(await (await get(OFFGRID_SOURCES.devTo)).json()) },
  {
    name: 'r/off_grid_ai',
    read: async () => parseReddit(await (await get(OFFGRID_SOURCES.reddit)).json())
  }
]

/** Every site page, read together: the cards they carry, once each, and the quick start's steps. */
async function site(query: string): Promise<{ site: OffgridSite; failed: string[] }> {
  const pages = await Promise.allSettled(
    OFFGRID_SITE_PAGES.map(async (page) => (await get(page.url)).text())
  )
  const html = pages.map((p) => (p.status === 'fulfilled' ? p.value : ''))
  const seen = new Set<string>()
  const cards = html
    .flatMap((page) => parseSiteCards(page))
    .filter((card) => !seen.has(card.url) && Boolean(seen.add(card.url)))
  // The pages that answer the question, or Mission and Vision, are read in full for detail.
  const toRead = pagesToRead(cards, query)
  const read = await Promise.allSettled(
    toRead.map(async (page) => parsePageBody(await (await get(page.url)).text()))
  )
  const bodies: Record<string, string> = {}
  toRead.forEach((page, i) => {
    const result = read[i]!
    if (result.status === 'fulfilled' && result.value) bodies[page.url] = result.value
  })
  return {
    site: { steps: parsePageSteps(html[0] ?? ''), pages: cards, bodies },
    failed: [
      ...OFFGRID_SITE_PAGES.filter((_, i) => pages[i]!.status === 'rejected').map(
        (page) => `${page.name} (${page.url})`
      ),
      ...toRead.filter((_, i) => read[i]!.status === 'rejected').map((page) => page.url)
    ]
  }
}

export const offgridGuideTool = {
  name: 'offgrid_guide',
  description:
    "What Off Grid AI can do (free and Pro, desktop, mobile, browser extension), how to set it up and use it, and what is new: the quick start, guides, articles, perspectives and ethos on getoffgridai.co, plus the latest releases and community posts. Use when the user asks about Off Grid AI's features, how to do something in it, or what changed. Pass `query` to find the pages about one task and read the best of them in full. Reads public pages; requires network.",
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Optional: the task or topic to find pages about, e.g. "sync attachments"'
      }
    }
  },
  run: async (args: Record<string, unknown> = {}): Promise<string> => {
    const query = typeof args.query === 'string' ? args.query : ''
    const [fromSite, news] = await Promise.all([
      site(query),
      Promise.allSettled(SOURCES.map((s) => s.read()))
    ])
    const failed = [
      ...fromSite.failed,
      ...SOURCES.filter((_, i) => news[i]!.status === 'rejected').map((s) => s.name)
    ]
    const updates = news.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    return formatGuide(newestUpdates(updates), failed, fromSite.site, query)
  }
}
