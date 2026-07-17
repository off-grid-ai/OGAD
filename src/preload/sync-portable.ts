import type { SyncPortableApi } from '../shared/sync-portable-contract'
import { SYNC_PORTABLE_CHANNELS } from '../shared/sync-portable-contract'

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>

export function createSyncPortableApi(invoke: Invoke): SyncPortableApi {
  return {
    summary: () => invoke(SYNC_PORTABLE_CHANNELS.summary) as ReturnType<SyncPortableApi['summary']>,
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
    importPicker: () =>
      invoke(SYNC_PORTABLE_CHANNELS.importPicker, 'keep-existing') as ReturnType<
        SyncPortableApi['importPicker']
      >
  }
}
