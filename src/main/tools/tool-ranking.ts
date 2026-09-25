// Smart tool routing: rank connector tools by relevance to the user's message so
// that when many connectors are enabled, the tools most relevant to THIS turn are
// the ones that survive the context budget — instead of whichever happened to be
// last (the budgeter drops from the end). Built-ins are never reordered.
//
// Lexical scoring for now: no per-turn cost, pure, deterministic, unit-testable.
// The scoring is isolated in scoreTool() so an embedding-backed scorer (desktop
// already runs an embeddings backend) can replace it later with ZERO change to
// the caller or to rankConnectorTools — the routing seam, not a fixed algorithm.

// Common words carry no routing signal; drop them so "what's on my calendar"
// matches a calendar tool on "calendar", not on "my"/"on".
const STOP = new Set([
  'the',
  'a',
  'an',
  'of',
  'to',
  'in',
  'on',
  'for',
  'and',
  'or',
  'is',
  'are',
  'my',
  'me',
  'i',
  'you',
  'with',
  'what',
  'whats',
  'can',
  'do',
  'please',
  'show',
  'get',
  'find'
])

/** Lowercase word tokens, stop-words + 1-char noise removed. */
export function terms(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1 && !STOP.has(w))
}

/** A tool's name + description, tolerant of both the OpenAI `{function:{…}}` wire
 *  shape and a bare `{name, description}` shape. */
function toolText(tool: unknown): { name: string; desc: string } {
  const t = tool as {
    name?: string
    description?: string
    function?: { name?: string; description?: string }
  }
  return {
    name: t.function?.name ?? t.name ?? '',
    desc: t.function?.description ?? t.description ?? ''
  }
}

/** Relevance of a tool to the query terms. A term matching the tool NAME weighs
 *  more than one matching only the description. 0 = nothing in common. */
export function scoreTool(queryTerms: string[], tool: unknown): number {
  if (!queryTerms.length) return 0
  const { name, desc } = toolText(tool)
  const nameTerms = new Set(terms(name))
  const descTerms = new Set(terms(desc))
  let score = 0
  for (const q of new Set(queryTerms)) {
    if (nameTerms.has(q)) {
      score += 3
    } else if (descTerms.has(q)) {
      score += 1
    }
  }
  return score
}

/** Reorder tools so the built-ins (the first `keepFirst`) stay put and the
 *  connector tools after them are sorted by DESCENDING relevance to `query`
 *  (stable for ties, preserving original order). Because the context budgeter
 *  drops connector tools from the end, ranking here means the LEAST relevant ones
 *  are dropped first. Returns the input unchanged when there's nothing to gain:
 *  ≤1 connector tool, an empty query, or no tool matched at all (avoid churn). */
export function rankConnectorTools(query: string, tools: unknown[], keepFirst: number): unknown[] {
  if (tools.length - keepFirst <= 1) {
    return tools
  }
  const qt = terms(query)
  if (!qt.length) {
    return tools
  }
  const builtins = tools.slice(0, keepFirst)
  const connectors = tools.slice(keepFirst)
  const scored = connectors.map((tool, i) => ({ tool, i, score: scoreTool(qt, tool) }))
  if (scored.every((s) => s.score === 0)) {
    return tools
  }
  scored.sort((a, b) => b.score - a.score || a.i - b.i)
  return [...builtins, ...scored.map((s) => s.tool)]
}

/** Offline fallback for semantic selection. Keep only tools with a direct term
 *  match. This fails closed instead of sending the full catalog when MiniLM is
 *  unavailable. */
export function selectRelevantTools(query: string, tools: unknown[]): unknown[] {
  const qt = terms(query)
  if (!qt.length) return []
  return tools
    .map((tool, index) => ({ tool, index, score: scoreTool(qt, tool) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 6)
    .map((candidate) => candidate.tool)
}
