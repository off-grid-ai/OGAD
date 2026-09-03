import type { SyncKnowledgeDocumentSource, SyncProPorts } from '@offgrid/application'
import { callHookAsync, HOOKS } from './bootstrap/hookRegistry'
import { emitSyncMutation } from './sync-mutation'

type SyncStatePort = NonNullable<SyncProPorts['state']>

/** Existing Pro sync runtime as I/O only. Shared owns mutation creation and document fan-out. */
export const desktopSyncStatePort: SyncStatePort = {
  record: emitSyncMutation,
  sendKnowledgeDocument: async (
    deviceId: string,
    document: SyncKnowledgeDocumentSource
  ): Promise<void> => {
    await callHookAsync(HOOKS.syncSendKnowledgeDocument, deviceId, document)
  }
}
