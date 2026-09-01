import { callHook, HOOKS } from './bootstrap/hookRegistry'
import {
  ACTION_APPROVAL_ENTITY,
  KNOWLEDGE_DOCUMENT_ENTITY,
  SHARED_FILE_ENTITY,
  TASK_CONTROL_ENTITY,
  TASK_LAUNCH_ENTITY,
  TASK_RUN_ENTITY,
  TASK_VISUAL_STEP_ENTITY
} from '@offgrid/sync'
import { encodeChangedModelSettings } from '@offgrid/models'
export { SYNCABLE_COMPUTER_USE_SETTING_KEYS, SYNCABLE_LLM_SETTING_KEYS } from '@offgrid/models'

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
  modelSetting: 'model_setting',
  actionApproval: ACTION_APPROVAL_ENTITY,
  taskLaunch: TASK_LAUNCH_ENTITY,
  taskRun: TASK_RUN_ENTITY,
  taskControl: TASK_CONTROL_ENTITY,
  taskVisualStep: TASK_VISUAL_STEP_ENTITY
} as const

export type CoreSyncEntity = (typeof CORE_SYNC_ENTITIES)[keyof typeof CORE_SYNC_ENTITIES]

export interface SyncMutation {
  entity: CoreSyncEntity
  entityId: string
  kind: 'put' | 'delete'
  /** Optional canonical fields for a committed owner that is not backed by the core SQLite DB. */
  fields?: Record<string, unknown>
}

export function emitChangedLlmSettings(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): void {
  for (const setting of encodeChangedModelSettings('desktop', before, after)) {
    emitSyncMutation({
      entity: CORE_SYNC_ENTITIES.modelSetting,
      entityId: setting.wireKey,
      kind: 'put',
      fields: { version: setting.version, value: JSON.parse(setting.valueJson) }
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
