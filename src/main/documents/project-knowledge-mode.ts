import type { ProjectDocumentsMode } from '@offgrid/rag/documents'

/**
 * Settings → Text → Project knowledge. When needed (the default) leaves the knowledge base to the
 * model's search tool, as before 0.0.55: a question that does not need it costs nothing, however
 * large the project. Relevant passages searches it for every question; Every answer reads it all.
 */
export function projectDocumentsMode(saved: unknown): ProjectDocumentsMode {
  return saved === 'relevant' || saved === 'every-answer' ? saved : 'when-needed'
}

export type { ProjectDocumentsMode }
