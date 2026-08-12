import { callHook, HOOKS } from './bootstrap/hookRegistry'

export interface KnowledgeDocumentSnapshot {
  syncId: string
  projectId: string
  name: string
  filePath: string
  fileSize: number
  createdAt: string
  enabled: boolean
}

export type KnowledgeDocumentMutation =
  | { kind: 'indexed'; document: KnowledgeDocumentSnapshot }
  | { kind: 'enabled'; syncId: string; enabled: boolean }
  | { kind: 'deleted'; syncId: string }

/** Notify the optional Pro coordinator only after the core RAG owner commits its local change. */
export function emitKnowledgeDocumentMutation(mutation: KnowledgeDocumentMutation): void {
  try {
    callHook(HOOKS.syncKnowledgeDocumentMutation, mutation)
  } catch (error) {
    console.error('[sync] Failed to record knowledge document mutation', mutation, error)
  }
}
