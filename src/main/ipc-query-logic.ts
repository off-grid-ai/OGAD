import { escapeFtsMatch } from './fts-match'

// Pure query/message helpers extracted from ipc.ts so the retrieval-gating logic
// is unit-testable without Electron / the DB (mirrors search-ranking.ts,
// model-sizing.ts). No side effects. ipc.ts re-imports these; the
// ipcMain.handle registrations stay in ipc.ts. Behaviour-neutral move.

/** Parse a model/LLM JSON reply into T, tolerating ```json fences; falls back on
 *  any parse error so a malformed reply never throws into the caller. */
export function safeParseJson<T>(input: string, fallback: T): T {
  try {
    const clean = input.replace(/```json\n?|\n?```/g, '').trim()
    return JSON.parse(clean) as T
  } catch {
    return fallback
  }
}

/** Stopwords dropped from a tokenised query (single source of truth). */
export const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'what',
  'know',
  'about',
  'your',
  'you',
  'me',
  'my',
  'all',
  'do',
  'are',
  'was',
  'were',
  'been',
  'being',
  'have',
  'has',
  'had',
  'will',
  'would',
  'should',
  'could',
  'can',
  'may',
  'might'
])

/** Extract lowercase Unicode words (keep internal hyphens/underscores),
 *  drop tokens < 3 chars and STOPWORDS, de-dup, cap at maxTokens. */
export function tokenizeQuery(query: string, maxTokens: number = 6): string[] {
  const tokens = (query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}_-]*/gu) ?? [])
    .filter((t) => t.length >= 3)
    .filter((t) => !STOPWORDS.has(t))
  return Array.from(new Set(tokens)).slice(0, maxTokens)
}

/** Any-term recall with the existing stopword filter, using the shared FTS escape. */
export function ftsMatchExpression(query: string, maxTokens: number = 6): string {
  const tokens = tokenizeQuery(query, maxTokens)
  return escapeFtsMatch(tokens.length ? tokens : query, { maxTokens })
}

/** Clip text to maxLength, replacing the final char with an ellipsis when it
 *  overflows. Empty/undefined text → ''. */
export function clipText(text: string, maxLength: number): string {
  if (!text) return ''
  if (text.length <= maxLength) return text
  return text.slice(0, Math.max(0, maxLength - 1)) + '…'
}

// Build/generate requests ("build a react app", "write an svg", "make a landing
// page") don't benefit from memory retrieval — pulling in unrelated SOURCES makes
// the model cite junk and second-guess itself. Detect them so we can answer with
// the artifact instructions only and skip the search.
export function isGenerativeRequest(text: string): boolean {
  const q = (text || '').trim().toLowerCase()
  if (!q) return false
  const hasNoun =
    /\b(react|next\.?js|vue|svelte|html|css|svg|website|web ?app|web ?page|landing page|component|widget|diagram|chart|flowchart|mermaid|game|canvas|prototype|mock-?up|ui|app|script|function|snippet|webpage|playground|frontend|front-end|dashboard|form|interface|page|tool|visualization|visualisation|simulator|editor|viewer|demo|site)\b/.test(
      q
    )
  const hasVerb =
    /\b(build|create|make|write|generate|code|implement|design|draw|render|scaffold|give me a|show me a)\b/.test(
      q
    )
  return hasNoun && hasVerb
}

/**
 * The `<column> LIKE ?` fragment + its bound param for an optional app-name
 * filter, or null when no filter applies ('All' / empty = every app). Callers add
 * their own connector (WHERE / AND). Single source for the appName gate that was
 * inlined 4× across db:get-memories and the rag:chat vector / FTS-fallback /
 * message queries (each with a different column, same guard + `%…%` wildcarding).
 */
export function appNameLikeClause(
  appName: string | undefined,
  column: string
): { clause: string; param: string } | null {
  if (!appName || appName === 'All') {
    return null
  }
  return { clause: `${column} LIKE ?`, param: `%${appName}%` }
}

/** A short pleasantry/acknowledgement ("hi", "ok", "thanks") — or empty — that
 *  shouldn't trigger memory extraction. Real messages return false. */
export function isTrivialMessage(text: string): boolean {
  const normalized = (text || '').trim()
  if (normalized.length === 0) return true
  if (normalized.length < 20) {
    if (
      /^(hi|hello|hey|thanks|thank you|ok|okay|sure|yes|no|cool|great|nice|good|fine|bye|see ya|yep|nope)[!.]?$/i.test(
        normalized
      )
    ) {
      return true
    }
  }
  return false
}
