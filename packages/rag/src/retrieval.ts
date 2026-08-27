// Retrieval: rank candidate chunks against a query embedding, optionally trim to
// a context-window budget, and format the survivors for prompt injection. Ported
// from Off Grid AI Mobile (rag/retrieval.ts). Pure: scoring only — fetching is the
// VectorStore's job.

import { cosineSimilarity } from './vectorMath'
import type { ChunkCandidate } from './bridges'
import type { RagSearchResult } from './types'

/** Score every candidate by cosine similarity and return the top-k, desc. */
export function rankBySimilarity(
  queryVec: number[],
  candidates: ChunkCandidate[],
  topK = 5
): RagSearchResult[] {
  return candidates
    .map((c) => ({
      docId: c.docId,
      name: c.name,
      content: c.content,
      position: c.position,
      score: cosineSimilarity(queryVec, c.embedding)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}

/** Characters of context to spend on retrieved KB excerpts for a given window.
 *  ~4 chars/token, reserve ~40% of the window for the knowledge base. */
export function estimateCharBudget(contextLengthTokens: number): number {
  return Math.max(1000, Math.floor(contextLengthTokens * 4 * 0.4))
}

/** Greedily keep top chunks until the character budget is exhausted. */
export function selectWithinBudget(
  chunks: RagSearchResult[],
  charBudget: number
): RagSearchResult[] {
  const out: RagSearchResult[] = []
  let total = 0
  for (const c of chunks) {
    if (out.length > 0 && total + c.content.length > charBudget) break
    out.push(c)
    total += c.content.length
  }
  return out
}

/** Wrap retrieved excerpts in a tagged block for the system/user prompt. */
export function formatForPrompt(result: { chunks: RagSearchResult[] }): string {
  if (!result.chunks.length) return ''
  const body = result.chunks
    .map((c) => `[Source: ${c.name} (part ${c.position + 1})]\n${c.content}`)
    .join('\n---\n')
  return (
    '<knowledge_base>\n' +
    "The following excerpts are from the user's project knowledge base. " +
    'Use them to answer and cite the source filename when you do.\n' +
    `${body}\n` +
    '</knowledge_base>'
  )
}
