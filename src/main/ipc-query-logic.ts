import { isArtifactBuildRequest } from '@offgrid/models'

// Pure query/message helpers extracted from ipc.ts so the retrieval-gating logic
// is unit-testable without Electron / the DB (mirrors search-ranking.ts,
// model-sizing.ts). No imports, no side effects. ipc.ts re-imports these; the
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

/** Tokenise a free-text query: lowercase, split on whitespace, strip punctuation
 *  (keep a-z0-9_-), drop tokens < 3 chars and STOPWORDS, de-dup, cap at maxTokens. */
export function tokenizeQuery(query: string, maxTokens: number = 6): string[] {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9_-]/g, ''))
    .filter((t) => t.length >= 3)
    .filter((t) => !STOPWORDS.has(t))
  return Array.from(new Set(tokens)).slice(0, maxTokens)
}

/** Quote one term as an FTS5 phrase literal, doubling any embedded quote per FTS5 escaping.
 *  A phrase literal makes retained punctuation inert - the tokeniser inside FTS re-splits it. */
function quoteFtsPhrase(term: string): string {
  return `"${term.replace(/"/g, '""')}"`
}

/** Build a safe FTS5 MATCH expression from free text: tokenise, then quote each token as a phrase
 *  literal and OR-join (any-term recall). tokenizeQuery keeps `-`/`_`, so a bare token like
 *  `best-reviewed` reaches MATCH as invalid syntax and throws `no such column: reviewed`, failing the
 *  whole rag:chat retrieval; quoting removes that entire class of syntax error. When tokenisation
 *  yields nothing (all stopwords / too short), fall back to the whole text as one quoted phrase so
 *  the fallback can't throw either. */
export function ftsMatchExpression(query: string, maxTokens: number = 6): string {
  const tokens = tokenizeQuery(query, maxTokens)
  if (tokens.length > 0) {
    return tokens.map(quoteFtsPhrase).join(' OR ')
  }
  return quoteFtsPhrase(query.trim())
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
  return isArtifactBuildRequest(text)
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
