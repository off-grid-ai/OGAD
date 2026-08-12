// @offgrid/rag — shared projects + RAG engine (pure TS over injectable bridges).

export type { MediaKind, Project, RagDocument, RagSearchResult, SearchResult } from './types'

export { chunkText, type Chunk, type ChunkOptions } from './chunking'
export { dotProduct, cosineSimilarity, topKSimilar, type SimilarityResult } from './vectorMath'
export {
  rankBySimilarity,
  estimateCharBudget,
  selectWithinBudget,
  formatForPrompt
} from './retrieval'
export {
  detectKind,
  extensionOf,
  extractContent,
  type ExtractOptions,
  type ExtractedContent
} from './extract'
export {
  RagService,
  type RagServiceDeps,
  type IndexDocumentParams,
  type IndexResult,
  type IndexStage
} from './service'
export { SEARCH_KB_TOOL, makeSearchKnowledgeBaseHandler } from './tools'
export type { EmbeddingProvider, VectorStore, ChunkCandidate, ExtractionBridges } from './bridges'
