import { describe, expect, it, vi } from 'vitest'
import { SYNC_PORTABLE_CHANNELS } from '../../shared/sync-portable-contract'
import { createSyncPortableApi } from '../sync-portable'

describe('createSyncPortableApi', () => {
  it('exposes the narrow namespaced IPC contract', async () => {
    const invoke = vi.fn().mockResolvedValue({ canceled: false })
    const api = createSyncPortableApi(invoke)

    await api.summary()
    await api.exportProject('project-1')
    await api.importPicker()

    expect(invoke).toHaveBeenNthCalledWith(1, SYNC_PORTABLE_CHANNELS.summary)
    expect(invoke).toHaveBeenNthCalledWith(2, SYNC_PORTABLE_CHANNELS.exportProject, 'project-1')
    expect(invoke).toHaveBeenNthCalledWith(3, SYNC_PORTABLE_CHANNELS.importPicker, 'keep-existing')
    expect(api).not.toHaveProperty('importPath')
  })
})
