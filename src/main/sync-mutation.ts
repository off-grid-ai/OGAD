import { callHook, HOOKS } from './bootstrap/hookRegistry'
import { KNOWLEDGE_DOCUMENT_ENTITY, SHARED_FILE_ENTITY } from '@offgrid/sync'

/**
 * Stable desktop entity names shared by the core writers and the private sync materializer.
 * Values are wire identities, so changing one requires a cross-platform migration.
 */
export const CORE_SYNC_ENTITIES = {
  conversation: 'conversation',
  message: 'message',
  project: 'project',
  knowledgeDocument: KNOWLEDGE_DOCUMENT_ENTITY,
  sharedFile: SHARED_FILE_ENTITY,
  modelSetting: 'model_setting'
} as const

export type CoreSyncEntity = (typeof CORE_SYNC_ENTITIES)[keyof typeof CORE_SYNC_ENTITIES]

export interface SyncMutation {
  entity: CoreSyncEntity
  entityId: string
  kind: 'put' | 'delete'
  /** Optional canonical fields for a committed owner that is not backed by the core SQLite DB. */
  fields?: Record<string, unknown>
}

/** User-controlled LLM settings that are safe and meaningful on another device. */
export const SYNCABLE_LLM_SETTING_KEYS = [
  'performanceMode',
  'temperature',
  'ctxSize',
  'topP',
  'topK',
  'minP',
  'repeatPenalty',
  'maxTokens',
  'systemPrompt',
  'kvCacheType',
  'flashAttn',
  'gpuLayers',
  'threads',
  'batchSize'
] as const

export function emitChangedLlmSettings(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): void {
  for (const key of SYNCABLE_LLM_SETTING_KEYS) {
    const value = after[key]
    if (value === undefined || Object.is(value, before[key])) continue
    emitSyncMutation({
      entity: CORE_SYNC_ENTITIES.modelSetting,
      entityId: key,
      kind: 'put',
      fields: { value }
    })
  }
}

/**
 * Core owns its committed writes; Pro optionally records them. Free builds register no hook, so
 * this is an inert call with no sync engine or Pro business logic in the public application.
 */
export function emitSyncMutation(mutation: SyncMutation): void {
  try {
    callHook(HOOKS.syncRecordLocalMutation, mutation)
  } catch (error) {
    console.error('[sync] Failed to record committed mutation', mutation, error)
  }
}
