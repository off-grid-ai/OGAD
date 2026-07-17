import type { SyncPortableApi } from '../shared/sync-portable-contract'
import { SYNC_PORTABLE_CHANNELS } from '../shared/sync-portable-contract'

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>

export function createSyncPortableApi(invoke: Invoke): SyncPortableApi {
  return {
    exportAll: () =>
      invoke(SYNC_PORTABLE_CHANNELS.exportAll) as ReturnType<SyncPortableApi['exportAll']>,
    exportProject: (projectId) =>
      invoke(SYNC_PORTABLE_CHANNELS.exportProject, projectId) as ReturnType<
        SyncPortableApi['exportProject']
      >,
    exportConversation: (conversationId) =>
      invoke(SYNC_PORTABLE_CHANNELS.exportConversation, conversationId) as ReturnType<
        SyncPortableApi['exportConversation']
      >,
    importPicker: (collisionPolicy) =>
      invoke(SYNC_PORTABLE_CHANNELS.importPicker, collisionPolicy) as ReturnType<
        SyncPortableApi['importPicker']
      >
  }
}
