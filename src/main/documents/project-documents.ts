// ProjectDocumentsPort: a project's knowledge base as document sources. Every chat filed in the
// project uses these files alongside its own attachments; the rules are the shared turn service's.
// Reads the knowledge-base rows (rag/store) directly: the knowledge-base service sits above this
// layer and uses it, so importing the service here would be a cycle. The service registers how
// it indexes a file that has no document id yet instead.

import fs from 'node:fs'
import type { DocumentSource, ProjectDocumentsPort } from '@offgrid/rag/documents'
import type { RagDocument } from '@offgrid/rag'

/** Kinds the engine reads from the file itself; the rest are indexed from their transcript or caption. */
const FILE_KINDS = new Set(['pdf', 'docx', 'text'])

type IndexMissing = (document: RagDocument, wait: boolean) => Promise<string | null>
let indexMissing: IndexMissing | null = null

/** The knowledge-base service gives the way it indexes a file that has no document id yet. */
export function setMissingDocumentIndexer(indexer: IndexMissing): void {
  indexMissing = indexer
}

async function sourceFor(document: RagDocument): Promise<DocumentSource | null> {
  // A file added before files had document ids is indexed now. A file the engine reads itself is
  // waited for, so this turn can use it; a transcript or caption joins later turns.
  const id =
    document.documentId ?? (await indexMissing?.(document, FILE_KINDS.has(document.kind))) ?? null
  if (!id) return null
  const onDisk = FILE_KINDS.has(document.kind) && fs.existsSync(document.path)
  return {
    id,
    name: document.name,
    kind: onDisk ? document.kind : 'text',
    ...(onDisk ? { path: document.path } : {})
  }
}

export const projectDocuments: ProjectDocumentsPort = {
  async forConversation(conversationId) {
    const { projectOfConversation } = await import('../rag/store')
    const projectId = projectOfConversation(conversationId)
    return projectId ? projectDocuments.forProject(projectId) : []
  },
  async forProject(projectId) {
    const { listRagDocuments } = await import('../rag/store')
    const sources: DocumentSource[] = []
    // Oldest first, so the stable prompt block keeps its order as files are added.
    for (const document of listRagDocuments(projectId).reverse()) {
      if (!document.enabled) continue
      const source = await sourceFor(document)
      if (source) sources.push(source)
    }
    return sources
  }
}

/** Every document id a knowledge base holds, so cache cleanup never drops one. */
export async function knowledgeBaseDocumentIds(): Promise<Set<string>> {
  const { listAllRagDocuments } = await import('../rag/store')
  return new Set(listAllRagDocuments().flatMap((document) => (document.documentId ? [document.documentId] : [])))
}
