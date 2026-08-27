// Vector math for retrieval, ported from Off Grid AI Mobile (rag/vectorMath.ts).
// Plain-JS cosine similarity over number[] embeddings — no SIMD, no deps. Fine
// for the brute-force search the RAG store does over a project's chunks.

export function dotProduct(a: number[], b: number[]): number {
  let dot = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) dot += a[i] * b[i]
  return dot
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

export interface SimilarityResult {
  index: number
  score: number
}

/** Top-k most similar candidate vectors to `query`, score-descending. */
export function topKSimilar(
  query: number[],
  candidates: number[][],
  k: number
): SimilarityResult[] {
  return candidates
    .map((c, index) => ({ index, score: cosineSimilarity(query, c) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
}
