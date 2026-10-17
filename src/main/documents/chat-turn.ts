// The chat turn's view of its documents (the project's knowledge base and the chat's attachments): runs the shared turn service with this machine's
// measured reading speed, reports progress in the work timeline, and turns the passages the model
// may cite into the turn's sources (`[S#]` → the Sources panel and citation pills).

import {
  describeTurnStatus,
  type DocumentBudgetInput,
  type DocumentSource,
  type DocumentTurnSummary,
  type FoundPassage
} from '@offgrid/rag/documents'
import { projectDocumentsMode } from './project-knowledge-mode'
import type { SearchResult } from '../../shared/search-contract'
import { attachmentSource } from './conversation-documents'
import {
  documentPrefillRate,
  documentTurns,
  previousDocumentSources,
  rememberDocumentSources
} from '.'

export type TurnDocumentRef = {
  documentId?: string
  name: string
  kind: string
  text?: string
  path?: string
}

export type DocumentsActivity = {
  kind: 'documents'
  label: string
  documents?: DocumentTurnSummary[]
}

export interface TurnDocuments {
  stable: string
  turn: string
  /** In citation order: `[S1]` is the first. */
  sources: SearchResult[]
  documents: DocumentTurnSummary[]
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** A passage as a turn source: the same key whether the turn or a search tool cited it. */
export function passageSource(passage: {
  documentId: string
  name: string
  page: number
  label?: string
  position: number
  snippet: string
}): SearchResult {
  return {
    key: `attachment:${passage.documentId}:${passage.page}:${passage.position}`,
    kind: 'attachment',
    refId: passage.page,
    title: `${passage.name} · ${passage.label ?? `p. ${passage.page}`}`,
    snippet: passage.snippet,
    surface: passage.name,
    url: null,
    ts: 0,
    imagePath: null,
    score: 0
  }
}

export function foundPassageSource(passage: FoundPassage): SearchResult {
  return passageSource({ ...passage, snippet: passage.text.slice(0, 280) })
}

export async function prepareTurnDocuments(input: {
  conversationId?: string
  /** The project of a chat that is not saved yet; a saved one is looked up from the conversation. */
  projectId?: string
  current: TurnDocumentRef[]
  question: string
  history: { role: string; content: string }[]
  budget: Omit<DocumentBudgetInput, 'prefillTokensPerSecond' | 'remote'>
  onActivity?: (activity: DocumentsActivity) => void
}): Promise<TurnDocuments | null> {
  const current: DocumentSource[] = []
  for (const ref of input.current) {
    const source = await attachmentSource(ref)
    if (source) current.push(source)
  }
  const scope = {
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {})
  }
  const { getSetting } = await import('../database')
  const projectDocuments = projectDocumentsMode(getSetting<unknown>('knowledgeBaseRetrieval', null))
  // When needed: a project's knowledge base is not opened for the turn; the model searches it.
  const sources = await documentTurns.documentsFor(scope, current, {
    includeProject: projectDocuments !== 'when-needed'
  })
  if (!sources.length) return null
  const { getActiveRemoteVisionServer } = await import('../vision/remote-vision-server')
  const result = await documentTurns.prepare({
    ...scope,
    current,
    // Settings → Text → Project knowledge.
    projectDocuments,
    onStatus: (status) =>
      input.onActivity?.({ kind: 'documents', label: describeTurnStatus(status) }),
    question: input.question,
    previousQuestions: input.history
      .filter((turn) => turn.role === 'user')
      .map((turn) => turn.content)
      .slice(-2),
    previousSources: previousDocumentSources(input.conversationId),
    budget: {
      ...input.budget,
      prefillTokensPerSecond: documentPrefillRate(),
      remote: !!getActiveRemoteVisionServer()
    }
  })
  if (!result) return null
  rememberDocumentSources(input.conversationId, result.usedKeys)
  const passages = result.documents.reduce((sum, document) => sum + document.passages, 0)
  input.onActivity?.({
    kind: 'documents',
    label:
      result.mode === 'whole'
        ? `Read ${plural(result.documents.length, 'document')} in full`
        : `Read ${plural(result.documents.length, 'document')} · ${plural(passages, 'passage')}`,
    documents: result.documents
  })
  return {
    stable: result.stable,
    turn: result.turn,
    documents: result.documents,
    sources: result.sources.map(passageSource)
  }
}
