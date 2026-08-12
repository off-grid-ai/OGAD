// Core data model for Off Grid projects + RAG, mirrored from Off Grid Mobile so
// desktop and mobile share one shape. The DB-level representation lives in each
// platform's VectorStore implementation; these are the engine-facing types.

/** What a knowledge-base file is, which decides how its text is extracted. */
export type MediaKind = 'text' | 'pdf' | 'docx' | 'audio' | 'video' | 'image'

/** A workspace: a named container scoping chat threads + a knowledge base. */
export interface Project {
  id: string
  name: string
  description: string
  systemPrompt: string
  icon?: string
  createdAt: string
  updatedAt: string
}

/** A file added to a project's knowledge base. */
export interface RagDocument {
  id: number
  /** Stable RFC 4122 identity used across devices. The integer id remains local-only. */
  syncId: string
  projectId: string
  name: string
  path: string
  size: number
  kind: MediaKind
  createdAt: string
  enabled: boolean
}

/** One ranked excerpt returned from retrieval. */
export interface RagSearchResult {
  docId: number
  name: string
  content: string
  position: number
  score: number
}

/** The result of a knowledge-base query: ranked excerpts for `query`. */
export interface SearchResult {
  chunks: RagSearchResult[]
  query: string
}
