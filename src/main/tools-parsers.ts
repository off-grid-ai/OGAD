// Pure HTML / URL parsers extracted from tools.ts so the web-tool text
// extraction is unit-testable without fetch / the tool loop (mirrors
// search-ranking.ts). No imports, no side effects. tools.ts re-imports these;
// the tool defs + agentic loop stay there. Behaviour-neutral move.

/** Decode the HTML entities the web tools care about (named + numeric decimal). `&amp;` goes
 *  last, so "&amp;lt;" reads as the text "&lt;", not as "<". */
export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
}

/** Remove tags until none is left, so pieces of a tag cannot join into a new one. */
function removeTags(s: string, replacement: string): string {
  let previous: string
  let text = s
  do {
    previous = text
    text = text.replace(/<[^>]*>/g, replacement)
  } while (text !== previous)
  return text
}

/** Strip all tags, decode entities, collapse whitespace, trim (for titles/snippets). */
export function stripTags(s: string): string {
  return decodeEntities(removeTags(s, ''))
    .replace(/\s+/g, ' ')
    .trim()
}

/** Convert an HTML document to readable text: drop script/style, turn block-close
 *  tags into newlines, strip remaining tags, decode entities, collapse runs of
 *  spaces/tabs and 3+ newlines. */
export function htmlToText(html: string): string {
  const body = html
    .replace(/<script\b[\s\S]*?<\/script[^>]*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style[^>]*>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|br|tr|section|article)>/gi, '\n')
  return decodeEntities(removeTags(body, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// DuckDuckGo wraps result links in a redirect: //duckduckgo.com/l/?uddg=<encoded>
/** Unwrap a DuckDuckGo redirect href to the real target URL; protocol-relative
 *  ('//host/...') hrefs are made https. Non-redirect hrefs pass through. */
export function decodeDdgHref(href: string): string {
  const m = /[?&]uddg=([^&]+)/.exec(href)
  if (m) {
    try {
      return decodeURIComponent(m[1]!)
    } catch {
      /* fall through */
    }
  }
  return href.startsWith('//') ? 'https:' + href : href
}
