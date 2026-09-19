// Semantic tool routing: rank connector tools by EMBEDDING similarity to the
// user's message, so a tool matches on meaning ("what meetings do I have" → a
// "calendar events" tool) rather than only on shared words. This is the
// embedding-backed implementation of the routing seam; the lexical
// rankConnectorTools() stays as the fallback for when the embeddings backend
// isn't ready. Tool embeddings are cached by content hash (name+description
// rarely change), so across turns only the query is embedded fresh.

export interface EmbedDeps {
  /** Returns a NORMALIZED embedding (so cosine similarity == dot product). */
  embed: (text: string) => Promise<number[]>
}

const MAX_RELEVANT_TOOLS = 6
const STRONG_RELEVANCE = 0.24
const INTENT_RELEVANCE = 0.16
const SCORE_WINDOW = 0.1

const TOOL_INTENT =
  /\b(search|find|look up|latest|current|today|tomorrow|meeting|calendar|schedule|remind|tell|send|email|message|open|browse|website|web|screen|memory|remember|calculate|math|time|date|image|picture|photo|draw|generate|location|weather)\b|\d\s*[+*/-]\s*\d/i

// Process-lifetime cache of tool embeddings, keyed by a hash of the tool text.
const toolVecCache = new Map<string, number[]>()

// djb2 — a cheap content hash for the cache key (not security-sensitive).
function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i)
  }
  return (h >>> 0).toString(36)
}

function toolText(tool: unknown): string {
  const t = tool as {
    name?: string
    description?: string
    function?: { name?: string; description?: string }
  }
  const name = t.function?.name ?? t.name ?? ''
  const desc = t.function?.description ?? t.description ?? ''
  return `${name}\n${desc}`.trim()
}

/** Dot product — equals cosine similarity for normalized vectors. */
function dot(a: number[], b: number[]): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    s += (a[i] ?? 0) * (b[i] ?? 0)
  }
  return s
}

async function embedTool(text: string, embed: EmbedDeps['embed']): Promise<number[]> {
  const key = hash(text)
  const hit = toolVecCache.get(key)
  if (hit) {
    return hit
  }
  const v = await embed(text)
  toolVecCache.set(key, v)
  return v
}

/** Reorder tools so the built-ins (first `keepFirst`) stay put and the connector
 *  tools after them are sorted by DESCENDING cosine similarity to `query`. Returns
 *  the input unchanged when there's nothing to gain (≤1 connector tool, empty
 *  query). THROWS if the query itself can't be embedded — the caller catches that
 *  and falls back to lexical ranking. A single tool that fails to embed is ranked
 *  last rather than failing the whole turn. */
export async function rankConnectorToolsSemantic(
  query: string,
  tools: unknown[],
  keepFirst: number,
  deps: EmbedDeps
): Promise<unknown[]> {
  if (tools.length - keepFirst <= 1 || !query.trim()) {
    return tools
  }
  const qv = await deps.embed(query) // may throw → caller falls back to lexical
  const builtins = tools.slice(0, keepFirst)
  const connectors = tools.slice(keepFirst)
  const scored = await Promise.all(
    connectors.map(async (tool, i) => {
      try {
        const tv = await embedTool(toolText(tool), deps.embed)
        return { tool, i, score: dot(qv, tv) }
      } catch {
        return { tool, i, score: -1 } // un-embeddable → rank last, don't fail all
      }
    })
  )
  scored.sort((a, b) => b.score - a.score || a.i - b.i)
  return [...builtins, ...scored.map((s) => s.tool)]
}

/** Select the small set of tools that is pertinent to this message. Unlike the
 *  older rank-only path, this scores built-ins and connector tools together, so
 *  an unrelated schema is never sent merely because there is room for it. A
 *  clear tool-intent phrase permits a lower score for short requests such as
 *  "tell Ali"; ordinary chat needs stronger semantic evidence. */
export async function selectRelevantToolsSemantic(
  query: string,
  tools: unknown[],
  deps: EmbedDeps
): Promise<unknown[]> {
  if (!query.trim() || tools.length === 0) return []

  const qv = await deps.embed(query)
  const scored = await Promise.all(
    tools.map(async (tool, index) => {
      try {
        return { tool, index, score: dot(qv, await embedTool(toolText(tool), deps.embed)) }
      } catch {
        return { tool, index, score: -1 }
      }
    })
  )
  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  const best = scored[0]?.score ?? -1
  const floor = TOOL_INTENT.test(query) ? INTENT_RELEVANCE : STRONG_RELEVANCE
  if (best < floor) return []

  return scored
    .filter((candidate) => candidate.score >= floor && candidate.score >= best - SCORE_WINDOW)
    .slice(0, MAX_RELEVANT_TOOLS)
    .map((candidate) => candidate.tool)
}

/** Test-only: clear the tool-embedding cache between cases. */
export function _clearToolVecCache(): void {
  toolVecCache.clear()
}
