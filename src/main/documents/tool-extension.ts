// Document tools for models that use tools (Jan's retrieve + get_chunks, LibreChat's file_search):
// the answer's own passages come first; these let the model look further — another part of a
// book, or exact pages. Offered only on turns that have documents (toolChat adds the schemas), so
// other turns do not pay for them. They see the same documents as the turn: the project's
// knowledge base and the chat's attachments.

import { describeTurnStatus } from '@offgrid/rag/documents'
import type { SearchResult } from '../../shared/search-contract'
import { documentStore, documentTurns } from '.'
import { foundPassageSource, type DocumentsActivity } from './chat-turn'

/**
 * What these tools read from the tool loop's context (fields of tools.ts's ToolContext). Declared
 * here, not imported: the tool loop imports this module, so importing it back would be a cycle.
 */
export interface DocumentToolContext {
  conversationId?: string
  projectId?: string
  citeDocumentPassage?: (source: SearchResult) => number
  onActivity?: (activity: DocumentsActivity) => void
}

const SEARCH = 'search_documents'
const READ = 'read_pages'
/** A tool result stays small enough to leave room for the answer. */
const MAX_CHARS = 6_000

export const documentToolSchemas = [
  {
    type: 'function',
    function: {
      name: SEARCH,
      description:
        'Search the documents of this chat (attachments and the project knowledge base) for passages about something. Cite passages by their [S#] tag.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for.' },
          document: {
            type: 'string',
            description: 'Optional: part of a document name to search only that file.'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: READ,
      description: 'Read specific pages of a document in this chat, e.g. pages 40 to 42.',
      parameters: {
        type: 'object',
        properties: {
          document: { type: 'string', description: 'Part of the document name.' },
          from: { type: 'number', description: 'First page.' },
          to: { type: 'number', description: 'Last page (at most 5 pages after the first).' }
        },
        required: ['document', 'from']
      }
    }
  }
]

function where(label: string | undefined, page: number): string {
  return label ?? `p. ${page}`
}

/** The documents this tool call may see. */
function scopeOf(context: DocumentToolContext | undefined): { conversationId?: string; projectId?: string } {
  return {
    ...(context?.conversationId ? { conversationId: context.conversationId } : {}),
    ...(context?.projectId ? { projectId: context.projectId } : {})
  }
}

/**
 * Search the documents in scope and return passages tagged with the `[S#]` numbers they get in
 * this turn's sources (also used by search_knowledge_base).
 */
export async function searchDocumentsForTool(
  context: DocumentToolContext | undefined,
  query: string,
  documentName?: string
): Promise<string> {
  let next = 1
  const result = await documentTurns.searchForTool(
    scopeOf(context),
    query,
    (passage) => context?.citeDocumentPassage?.(foundPassageSource(passage)) ?? next++,
    {
      ...(documentName ? { documentName } : {}),
      onStatus: (status) =>
        context?.onActivity?.({ kind: 'documents', label: describeTurnStatus(status) })
    }
  )
  return result.text.slice(0, MAX_CHARS)
}

export const documentToolExtension = {
  id: 'attached-documents',
  category: 'tool' as const,
  // Added per turn by toolChat when the conversation has documents, never from the shared list.
  schemas: (): unknown[] => [],
  canHandle: (name: string): boolean => name === SEARCH || name === READ,
  isReadOnlyTool: (): boolean => true,
  async execute(
    name: string,
    args: Record<string, unknown>,
    context?: DocumentToolContext
  ): Promise<string> {
    if (name === SEARCH) {
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (!query) return 'Give a query to search for.'
      const documentName =
        typeof args.document === 'string' && args.document.trim() ? args.document.trim() : undefined
      return searchDocumentsForTool(context, query, documentName)
    }
    const wanted = typeof args.document === 'string' ? args.document.trim().toLowerCase() : ''
    const from = Math.max(1, Math.floor(Number(args.from) || 1))
    const to = Math.min(from + 5, Math.max(from, Math.floor(Number(args.to) || from)))
    const sources = await documentTurns.documentsFor(scopeOf(context), [])
    const source =
      sources.find((candidate) => candidate.name.toLowerCase().includes(wanted)) ?? sources[0]
    if (!source) return 'This chat has no documents.'
    const pages = (await documentStore.readPages(source.id)).filter(
      (page) => page.page >= from && page.page <= to
    )
    if (!pages.length) return `${source.name} has no pages ${from}–${to}.`
    return pages
      .map((page) =>
        page.needsOcr && !page.text.trim()
          ? `[${source.name}, ${where(page.label, page.page)}] (scanned page, not read yet)`
          : `[${source.name}, ${where(page.label, page.page)}]\n${page.text.trim()}`
      )
      .join('\n\n')
      .slice(0, MAX_CHARS)
  },
  systemHint: (): string =>
    'search_documents and read_pages look further into this chat\'s documents when the passages given are not enough.'
}
