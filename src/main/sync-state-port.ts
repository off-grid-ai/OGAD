import type { SyncKnowledgeDocumentSource, SyncStatePort } from '@offgrid/sync'
import { callHook, callHookAsync, HOOKS } from './bootstrap/hookRegistry'
import { emitSyncMutation } from './sync-mutation'

/** Existing Pro sync runtime as I/O only. Shared owns mutation creation and document fan-out. */
export const desktopSyncStatePort: SyncStatePort = {
  record: emitSyncMutation,
  connectedDeviceIds: () => callHook<readonly string[]>(HOOKS.syncConnectedDeviceIds) ?? [],
  sendKnowledgeDocument: async (
    deviceId: string,
    document: SyncKnowledgeDocumentSource
  ): Promise<void> => {
    await callHookAsync(HOOKS.syncSendKnowledgeDocument, deviceId, document)
  }
}
