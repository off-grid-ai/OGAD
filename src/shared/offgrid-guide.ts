// What God knows about Off Grid AI itself: what the product does, and where its news is posted.
// The overview ships with the app; the news is read from the public sources below only when the
// user asks about features or what is new. Parsers are pure so they are tested without network.

/** What Off Grid AI does today, in short. Kept with the app so God answers without network. */
export const OFFGRID_FEATURES = `Off Grid AI runs AI on your own computer and phone. Nothing you ask leaves your device unless you connect something that needs it.

Free on Desktop (macOS, Windows, Linux):
- Chat with text and vision models, with a thinking mode, answer versions and per-chat settings.
- Image generation from text or an image (SDXL-Lightning, SDXL, SD 1.5/2.1, Z-Image-Turbo), with live preview.
- Voice: speech to text with whisper, text to speech with Kokoro, and a hands-free voice mode.
- Artifacts: HTML, React, SVG, Mermaid and Markdown rendered live in a sandbox.
- Projects: group chats, add documents, and chat grounded in them with cited sources.
- Tools in chat: web search, read a page, calculator, memory search, and any MCP connector.
- Connectors (MCP) and direct account connections (Google, Microsoft, Obsidian), read live.
- Models: curated catalog and Hugging Face search, one active model per kind.
- The Gateway: one OpenAI-compatible endpoint at 127.0.0.1:7878 for other apps.
- God: this assistant. Chat or voice mode, wake word "Ares", knows your day, asks before it acts.

Pro (desktop):
- Sees and remembers: screen understanding into Day, Entities (a private CRM) and Replay.
- Reflect: where your attention went, by day and week.
- Meetings: records Google Meet and Zoom, transcribes on the device, summarises.
- Dictation: hold Option+Space, talk, and the text is pasted where your cursor is.
- Clipboard history with previews and a quick-paste popup.
- Acts with approval: action items, an approval queue with an audit log, Web Use and Computer Use.

Also: the Off Grid AI mobile app (iOS, Android) and the browser extension (Chrome, Firefox), which pairs with Desktop over a sealed local link.`

export type UpdateKind = 'release' | 'article' | 'community' | 'guide' | 'essay' | 'about'

/** One piece of Off Grid AI news: a release, an article or a community post. */
export interface OffgridUpdate {
  readonly kind: UpdateKind
  readonly title: string
  readonly url: string
  /** ISO date, when the source gives one. */
  readonly date?: string
  /** Where it came from, for the answer: "Desktop release", "dev.to", ... */
  readonly source: string
  readonly summary?: string
}

/** Where Off Grid AI's news is posted. Public pages only; nothing about the user is sent. */
export const OFFGRID_SOURCES = {
  githubOrg: 'https://api.github.com/orgs/off-grid-ai/repos?sort=pushed&per_page=10&type=public',
  releases: (repo: string): string =>
    `https://api.github.com/repos/off-grid-ai/${encodeURIComponent(repo)}/releases?per_page=5`,
  devTo: 'https://dev.to/api/articles?username=alichherawalla&per_page=10',
  reddit: 'https://www.reddit.com/r/off_grid_ai/new.json?limit=10'
} as const

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const isoDate = (v: unknown): string | undefined => {
  const t = Date.parse(text(v))
  return Number.isNaN(t) ? undefined : new Date(t).toISOString()
}
const firstLine = (v: unknown, max = 200): string | undefined => {
  const line = text(v)
    .replace(/[#*_`>]/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) {
    return undefined
  }
  return line.length > max ? `${line.slice(0, max - 3)}...` : line
}

/** Public repository names from the GitHub org listing. */
export function parseOrgRepos(json: unknown): string[] {
  if (!Array.isArray(json)) {
    return []
  }
  return json
    .filter((r) => r && typeof r === 'object' && !(r as { archived?: boolean }).archived)
    .map((r) => text((r as { name?: unknown }).name))
    .filter(Boolean)
}

/** Published releases of one repository, newest first as GitHub returns them. */
export function parseGithubReleases(json: unknown, repo: string): OffgridUpdate[] {
  if (!Array.isArray(json)) {
    return []
  }
  return json.flatMap((r) => {
    const rel = r as Record<string, unknown>
    const url = text(rel.html_url)
    if (rel.draft === true || !url) {
      return []
    }
    return [
      {
        kind: 'release' as const,
        title: text(rel.name) || text(rel.tag_name) || 'Release',
        url,
        date: isoDate(rel.published_at),
        source: `${repo} release`,
        summary: firstLine(rel.body)
      }
    ]
  })
}

/** Articles from the dev.to API. */
export function parseDevTo(json: unknown): OffgridUpdate[] {
  if (!Array.isArray(json)) {
    return []
  }
  return json.flatMap((a) => {
    const art = a as Record<string, unknown>
    const url = text(art.url)
    const title = text(art.title)
    return url && title
      ? [
          {
            kind: 'article' as const,
            title,
            url,
            date: isoDate(art.published_at),
            source: 'dev.to',
            summary: firstLine(art.description)
          }
        ]
      : []
  })
}

/** Posts from the subreddit's JSON listing. */
export function parseReddit(json: unknown): OffgridUpdate[] {
  const children = (json as { data?: { children?: unknown } } | null)?.data?.children
  if (!Array.isArray(children)) {
    return []
  }
  return children.flatMap((c) => {
    const post = (c as { data?: Record<string, unknown> }).data ?? {}
    const title = text(post.title)
    const permalink = text(post.permalink)
    if (!title || !permalink.startsWith('/r/')) {
      return []
    }
    const created = typeof post.created_utc === 'number' ? post.created_utc * 1000 : NaN
    return [
      {
        kind: 'community' as const,
        title,
        url: `https://www.reddit.com${permalink}`,
        date: Number.isNaN(created) ? undefined : new Date(created).toISOString(),
        source: 'r/off_grid_ai',
        summary: firstLine(post.selftext)
      }
    ]
  })
}

/** The Off Grid AI site, and the pages the guide reads. Every page carries the site's catalogue
 *  of cards; each also has its own content (the quick start's steps). */
export const OFFGRID_SITE = 'https://getoffgridai.co'
export const OFFGRID_SITE_PAGES = [
  { name: 'Quick start', url: `${OFFGRID_SITE}/quick-start/` },
  { name: 'Guides', url: `${OFFGRID_SITE}/guides/` },
  { name: 'Articles', url: `${OFFGRID_SITE}/articles/` },
  { name: 'Perspectives', url: `${OFFGRID_SITE}/writing/` },
  { name: 'Ethos', url: `${OFFGRID_SITE}/ethos/` }
] as const

const SOURCE_SITE = 'getoffgridai.co'

/** Page text as written: tags out, entities decoded once, spaces collapsed. */
function pageText(fragment: string): string {
  // &amp; last: decoding it first would turn "&amp;quot;" into a quote mark.
  return fragment
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .replace(/ ([.,;:!?])/g, '$1')
    .trim()
}

const attribute = (attrs: string, name: string): string =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? ''

const span = (inner: string, cls: string): string =>
  pageText(
    new RegExp(`<span\\b[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)</span>`).exec(
      inner
    )?.[1] ?? ''
  )

/** What a site page is, from where it lives. */
function siteKind(path: string): UpdateKind {
  if (path.startsWith('/guides/')) return 'guide'
  if (path.startsWith('/articles/')) return 'article'
  if (path.startsWith('/writing/')) return 'essay'
  return 'about'
}

/** The guide, article, essay and about cards on a site page, once each, on the site only. */
export function parseSiteCards(html: string, base = OFFGRID_SITE): OffgridUpdate[] {
  const origin = new URL(base).origin
  const seen = new Set<string>()
  const out: OffgridUpdate[] = []
  const re = /<a\b([^>]*\bclass="[^"]*\bguide-card\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const href = attribute(m[1]!, 'href')
    const title = span(m[2]!, 'guide-card-title')
    if (!href || !title) continue
    const link = new URL(href, base)
    const url = link.toString()
    // The same site, by origin: a prefix would also accept getoffgridai.co.example.com.
    if (seen.has(url) || link.origin !== origin) continue
    seen.add(url)
    const summary = firstLine(span(m[2]!, 'guide-card-desc'))
    out.push({
      kind: siteKind(link.pathname),
      title,
      url,
      date: isoDate(attribute(m[1]!, 'data-date')),
      source: SOURCE_SITE,
      ...(summary ? { summary } : {})
    })
  }
  return out
}

/** The numbered steps on a page ("1. Install", "2. Prepare a model", ...), as plain text. */
export function parsePageSteps(html: string, maxChars = 4_000): string {
  const sections = html.split(/<h2\b[^>]*>/i).slice(1)
  const steps = sections.flatMap((section) => {
    const end = section.search(/<\/h2>/i)
    const heading = pageText(section.slice(0, end))
    if (end < 0 || !/^\d+\.\s/.test(heading)) return []
    return [`${heading}: ${pageText(section.slice(end + 5))}`]
  })
  const text = steps.join('\n')
  return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text
}

/** Site pages that answer `query`: title words count twice, summary words once; best first. */
export function matchSitePages(
  pages: readonly OffgridUpdate[],
  query: string,
  limit = 8
): OffgridUpdate[] {
  const words = [...new Set(query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])]
  if (!words.length) return []
  return pages
    .map((page) => {
      const title = page.title.toLowerCase()
      const summary = (page.summary ?? '').toLowerCase()
      const score = words.reduce(
        (sum, word) => sum + (title.includes(word) ? 2 : 0) + (summary.includes(word) ? 1 : 0),
        0
      )
      return { page, score }
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || (b.page.date ?? '').localeCompare(a.page.date ?? ''))
    .slice(0, limit)
    .map(({ page }) => page)
}

/** The newest updates across sources: dated ones newest first, undated ones after, capped. */
export function newestUpdates(updates: readonly OffgridUpdate[], limit = 12): OffgridUpdate[] {
  const seen = new Set<string>()
  const unique = updates.filter((u) => !seen.has(u.url) && Boolean(seen.add(u.url)))
  const dated = unique.filter((u) => u.date).sort((a, b) => b.date!.localeCompare(a.date!))
  return [...dated, ...unique.filter((u) => !u.date)].slice(0, limit)
}

/** How much of one page the guide reads in full. */
export const PAGE_BODY_CHARS = 8_000
/** How many matching pages the guide reads in full for a question. */
export const PAGES_READ_IN_FULL = 3

/**
 * A page's own content, as the site's search indexes it (the article marked data-pagefind-body),
 * as plain text that keeps its shape: headings as "## ", list items as "- ", table cells joined
 * by " | ", links as "label (url)". Empty when the page has no such content.
 */
export function parsePageBody(html: string, maxChars = PAGE_BODY_CHARS): string {
  const body = /<article\b[^>]*data-pagefind-body[^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1]
  if (!body) return ''
  // Repeat removal so joining the remaining text cannot create another excluded element.
  let content = body
  let previous: string
  do {
    previous = content
    content = content.replace(/<(script|style|svg|nav|button|form)\b[\s\S]*?<\/\1>/gi, '')
  } while (content !== previous)
  const lines = content
    // A link keeps where it goes, so an answer can hand over the exact page or download.
    .replace(
      /<a\b[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
      (_link, href: string, label: string) => `${label} (${href})`
    )
    .replace(/<h[1-6]\b[^>]*>/gi, '\n## ')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/t[dh]>\s*<t[dh]\b[^>]*>/gi, ' | ')
    .replace(/<(p|br|tr|div|section|blockquote|pre)\b[^>]*>/gi, '\n')
    .split('\n')
    .map((line) => pageText(line))
    .filter((line) => line && line !== '##' && line !== '-')
  const text = lines.join('\n')
  return text.length > maxChars ? `${text.slice(0, maxChars - 3).trimEnd()}...` : text
}

/** The pages worth reading in full: those that answer the question, or what Off Grid AI stands for. */
export function pagesToRead(pages: readonly OffgridUpdate[], query: string): OffgridUpdate[] {
  return query.trim()
    ? matchSitePages(pages, query, PAGES_READ_IN_FULL)
    : pages.filter((page) => page.kind === 'about')
}

/** Everything the guide read from the site. */
export interface OffgridSite {
  /** The quick start's numbered steps, or '' when that page could not be read. */
  readonly steps: string
  readonly pages: readonly OffgridUpdate[]
  /** Pages read in full (pagesToRead): each page's url to its content (parsePageBody). */
  readonly bodies?: Readonly<Record<string, string>>
}

const SITE_LIMITS = { guide: 20, article: 8, essay: 6 } as const

function listItems(updates: readonly OffgridUpdate[], withSource: boolean): string {
  return updates
    .map((u) => {
      const tag = withSource ? `[${u.source}] ` : ''
      const when = u.date ? ` (${u.date.slice(0, 10)})` : ''
      const about = u.summary ? `\n   ${u.summary}` : ''
      return `- ${tag}${u.title}${when}\n   ${u.url}${about}`
    })
    .join('\n')
}

function siteSection(site: OffgridSite, query: string): string {
  const parts: string[] = []
  if (site.steps) parts.push(`Quick start (${OFFGRID_SITE_PAGES[0].url}):\n${site.steps}`)
  const of = (kind: UpdateKind): OffgridUpdate[] => site.pages.filter((p) => p.kind === kind)
  if (query.trim()) {
    const matches = matchSitePages(site.pages, query)
    parts.push(
      matches.length
        ? `Pages on getoffgridai.co about "${query.trim()}":\n${listItems(matches, false)}`
        : `No page on getoffgridai.co matched "${query.trim()}".`
    )
  } else {
    const about = of('about')
    if (about.length) parts.push(`About Off Grid AI:\n${listItems(about, false)}`)
  }
  const read = pagesToRead(site.pages, query).filter((page) => site.bodies?.[page.url])
  for (const page of read) {
    parts.push(`${page.title} (${page.url}), in full:\n${site.bodies![page.url]}`)
  }
  const guides = of('guide').slice(0, SITE_LIMITS.guide)
  if (guides.length) parts.push(`Guides:\n${listItems(guides, false)}`)
  if (!query.trim()) {
    const articles = newestUpdates(of('article'), SITE_LIMITS.article)
    if (articles.length) parts.push(`Newest articles:\n${listItems(articles, false)}`)
    const essays = of('essay').slice(0, SITE_LIMITS.essay)
    if (essays.length) parts.push(`Perspectives:\n${listItems(essays, false)}`)
  }
  return parts.join('\n\n')
}

/** What the guide tool returns to the model: the feature overview, the site (its quick start,
 *  pages matching the question or an overview of the library), then the news it found. */
export function formatGuide(
  updates: readonly OffgridUpdate[],
  failed: readonly string[],
  site: OffgridSite = { steps: '', pages: [] },
  query = ''
): string {
  const news = updates.length ? listItems(updates, true) : 'No recent posts could be read.'
  const missing = failed.length ? `\nCould not reach: ${failed.join(', ')}.` : ''
  const fromSite = siteSection(site, query)
  return `${OFFGRID_FEATURES}${fromSite ? `\n\n${fromSite}` : ''}\n\nLatest from Off Grid AI:\n${news}${missing}\n\nWhen you mention a page, post or release, give its link.`
}

/** One line for God's instructions, so it reaches for the guide when it should. */
export const OFFGRID_GUIDE_HINT =
  "You are Off Grid AI's assistant. When the user asks what Off Grid AI can do, how to use a feature, or what is new, call offgrid_guide and answer from it with links."
